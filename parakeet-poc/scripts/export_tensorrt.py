#!/usr/bin/env python3
"""
Export NeMo Parakeet ASR model to ONNX and compile to TensorRT engine.

This script:
1. Loads a NeMo Parakeet CTC model from pretrained weights
2. Exports the encoder and decoder to ONNX format with dynamic axes
3. Compiles the ONNX models into a single TensorRT engine with FP16 mixed precision
4. Saves metadata (vocabulary, dimensions, model info) for inference

The preprocessor (mel spectrogram) is NOT exported -- it runs in PyTorch/NumPy
at inference time since it involves variable-length FFT operations that TRT
handles poorly.

Usage:
    python export_tensorrt.py --model nvidia/parakeet-ctc-0.6b --output-dir /app/trt_model --fp16
"""

import argparse
import json
import os
import sys
import time

import numpy as np
import torch


def parse_args():
    parser = argparse.ArgumentParser(
        description="Export NeMo Parakeet model to ONNX and TensorRT"
    )
    parser.add_argument(
        "--model",
        type=str,
        default="nvidia/parakeet-ctc-0.6b",
        help="NeMo model name or path (default: nvidia/parakeet-ctc-0.6b)",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="/app/trt_model",
        help="Output directory for exported files (default: /app/trt_model)",
    )
    parser.add_argument(
        "--max-sequence-length",
        type=int,
        default=3000,
        help="Max encoder sequence length (~30s at 10ms stride) (default: 3000)",
    )
    parser.add_argument(
        "--fp16",
        action="store_true",
        default=True,
        help="Enable FP16 mixed precision in TensorRT (default: enabled)",
    )
    parser.add_argument(
        "--no-fp16",
        action="store_true",
        default=False,
        help="Disable FP16 mixed precision",
    )
    return parser.parse_args()


def load_model(model_name):
    """Load NeMo ASR model from pretrained."""
    import nemo.collections.asr as nemo_asr

    print(f"[Export] Loading model: {model_name}")
    start = time.time()
    model = nemo_asr.models.ASRModel.from_pretrained(model_name)
    model.eval()
    if torch.cuda.is_available():
        model = model.cuda()
    elapsed = time.time() - start
    print(f"[Export] Model loaded in {elapsed:.2f}s")
    return model


def extract_vocabulary(model):
    """Extract vocabulary list from the model for CTC decoding."""
    vocab = None

    # Try decoder vocabulary attribute
    if hasattr(model, "decoder") and hasattr(model.decoder, "vocabulary"):
        vocab = list(model.decoder.vocabulary)
    elif hasattr(model, "cfg") and "labels" in model.cfg:
        vocab = list(model.cfg.labels)
    elif hasattr(model, "cfg") and "decoder" in model.cfg:
        decoder_cfg = model.cfg.decoder
        if hasattr(decoder_cfg, "vocabulary"):
            vocab = list(decoder_cfg.vocabulary)

    if vocab is None:
        raise RuntimeError(
            "Could not extract vocabulary from model. "
            "Ensure this is a CTC model with a vocabulary attribute."
        )

    return vocab


def export_encoder_onnx(model, output_path, max_seq_len):
    """Export the encoder to ONNX with dynamic axes."""
    print(f"[Export] Exporting encoder to ONNX: {output_path}")

    encoder = model.encoder
    device = next(encoder.parameters()).device

    # Encoder input: (batch, features, time)
    # NeMo ConformerEncoder expects audio_signal and length
    feature_dim = 80  # mel spectrogram features
    # Use a representative sequence length for tracing
    example_seq_len = 500
    dummy_input = torch.randn(1, feature_dim, example_seq_len, device=device)
    dummy_length = torch.tensor([example_seq_len], dtype=torch.long, device=device)

    # Export
    torch.onnx.export(
        encoder,
        (dummy_input, dummy_length),
        output_path,
        input_names=["audio_signal", "length"],
        output_names=["encoded", "encoded_len"],
        dynamic_axes={
            "audio_signal": {0: "batch_size", 2: "time"},
            "length": {0: "batch_size"},
            "encoded": {0: "batch_size", 1: "time_encoded"},
            "encoded_len": {0: "batch_size"},
        },
        opset_version=17,
        do_constant_folding=True,
    )
    print(f"[Export] Encoder ONNX saved: {output_path}")


def export_decoder_onnx(model, output_path, max_seq_len):
    """Export the decoder (linear projection) to ONNX with dynamic axes."""
    print(f"[Export] Exporting decoder to ONNX: {output_path}")

    decoder = model.decoder
    device = next(decoder.parameters()).device

    # Decoder input shape depends on encoder output dim
    # ConvASRDecoder expects (batch, features, time)
    encoder_dim = model.encoder.d_model if hasattr(model.encoder, "d_model") else 512
    example_time = 500
    dummy_encoder_output = torch.randn(1, encoder_dim, example_time, device=device)

    torch.onnx.export(
        decoder,
        (dummy_encoder_output,),
        output_path,
        input_names=["encoder_output"],
        output_names=["logits"],
        dynamic_axes={
            "encoder_output": {0: "batch_size", 2: "time_encoded"},
            "logits": {0: "batch_size", 1: "time_encoded"},
        },
        opset_version=17,
        do_constant_folding=True,
    )
    print(f"[Export] Decoder ONNX saved: {output_path}")


def build_tensorrt_engine(
    encoder_onnx_path, decoder_onnx_path, engine_path, max_seq_len, use_fp16
):
    """Build a TensorRT engine from ONNX models.

    We build encoder and decoder as separate TRT engines combined into one
    serialized file, or build them as separate engines. For simplicity,
    we build the encoder (the heavy part) as the main engine and include
    the decoder as a second engine in the same output directory.
    """
    import tensorrt as trt

    TRT_LOGGER = trt.Logger(trt.Logger.INFO)

    print(f"[Export] Building TensorRT engine (FP16={use_fp16})...")
    print(f"[Export] Max sequence length: {max_seq_len}")

    # Build encoder engine
    encoder_engine_path = engine_path.replace(".engine", "_encoder.engine")
    _build_single_engine(
        encoder_onnx_path,
        encoder_engine_path,
        TRT_LOGGER,
        use_fp16,
        input_profiles=[
            {
                "audio_signal": {
                    "min": (1, 80, 16),
                    "opt": (1, 80, 1500),
                    "max": (1, 80, max_seq_len),
                },
                "length": {
                    "min": (1,),
                    "opt": (1,),
                    "max": (1,),
                },
            }
        ],
    )

    # Build decoder engine
    # Need to determine encoder output dim from model config
    decoder_engine_path = engine_path.replace(".engine", "_decoder.engine")
    _build_single_engine(
        decoder_onnx_path,
        decoder_engine_path,
        TRT_LOGGER,
        use_fp16,
        input_profiles=[
            {
                "encoder_output": {
                    "min": (1, 512, 16),
                    "opt": (1, 512, 750),
                    "max": (1, 512, max_seq_len),
                },
            }
        ],
    )

    # Also create a combined reference engine path (symlink or copy encoder as main)
    # The main engine_path will point to encoder for backward compat
    if not os.path.exists(engine_path):
        os.symlink(os.path.basename(encoder_engine_path), engine_path)

    print(f"[Export] TensorRT engines built successfully")
    print(f"[Export]   Encoder: {encoder_engine_path}")
    print(f"[Export]   Decoder: {decoder_engine_path}")
    return encoder_engine_path, decoder_engine_path


def _build_single_engine(onnx_path, engine_path, logger, use_fp16, input_profiles):
    """Build a single TensorRT engine from an ONNX file."""
    import tensorrt as trt

    builder = trt.Builder(logger)
    network = builder.create_network(
        1 << int(trt.NetworkDefinitionCreationFlag.EXPLICIT_BATCH)
    )
    parser = trt.OnnxParser(network, logger)

    # Parse ONNX
    print(f"[Export]   Parsing ONNX: {onnx_path}")
    with open(onnx_path, "rb") as f:
        if not parser.parse(f.read()):
            for i in range(parser.num_errors):
                print(f"[Export]   ONNX parse error: {parser.get_error(i)}")
            raise RuntimeError(f"Failed to parse ONNX file: {onnx_path}")

    # Configure builder
    config = builder.create_builder_config()
    config.set_memory_pool_limit(trt.MemoryPoolType.WORKSPACE, 1 << 30)  # 1GB

    if use_fp16:
        if builder.platform_has_fast_fp16:
            config.set_flag(trt.BuilderFlag.FP16)
            print(f"[Export]   FP16 enabled (mixed precision)")
        else:
            print(f"[Export]   WARNING: FP16 not supported on this platform, using FP32")

    # Set optimization profiles for dynamic shapes
    profile = builder.create_optimization_profile()
    for profile_dict in input_profiles:
        for input_name, shapes in profile_dict.items():
            profile.set_shape(
                input_name, shapes["min"], shapes["opt"], shapes["max"]
            )
    config.add_optimization_profile(profile)

    # Build engine
    print(f"[Export]   Building engine (this may take several minutes)...")
    start = time.time()
    serialized_engine = builder.build_serialized_network(network, config)
    if serialized_engine is None:
        raise RuntimeError(f"Failed to build TensorRT engine for {onnx_path}")

    elapsed = time.time() - start
    print(f"[Export]   Engine built in {elapsed:.1f}s")

    # Save engine
    with open(engine_path, "wb") as f:
        f.write(serialized_engine)
    print(f"[Export]   Engine saved: {engine_path} ({os.path.getsize(engine_path) / 1e6:.1f}MB)")


def save_metadata(output_dir, model_name, vocab, encoder_dim, max_seq_len, use_fp16):
    """Save metadata JSON for inference runtime."""
    metadata = {
        "model_name": model_name,
        "vocabulary": vocab,
        "vocab_size": len(vocab) + 1,  # +1 for CTC blank token at index 0
        "encoder_dim": encoder_dim,
        "feature_dim": 80,
        "sample_rate": 16000,
        "hop_length": 160,  # 10ms at 16kHz
        "win_length": 320,  # 20ms at 16kHz
        "n_fft": 512,
        "n_mels": 80,
        "max_sequence_length": max_seq_len,
        "fp16": use_fp16,
        "blank_id": 0,
        "engine_files": {
            "encoder": "model_encoder.engine",
            "decoder": "model_decoder.engine",
        },
        "onnx_files": {
            "encoder": "encoder.onnx",
            "decoder": "decoder.onnx",
        },
    }

    metadata_path = os.path.join(output_dir, "metadata.json")
    with open(metadata_path, "w") as f:
        json.dump(metadata, f, indent=2)
    print(f"[Export] Metadata saved: {metadata_path}")
    return metadata_path


def main():
    args = parse_args()
    use_fp16 = args.fp16 and not args.no_fp16

    print(f"[Export] ================================================")
    print(f"[Export] NeMo Parakeet -> ONNX -> TensorRT Export")
    print(f"[Export] ================================================")
    print(f"[Export] Model: {args.model}")
    print(f"[Export] Output: {args.output_dir}")
    print(f"[Export] Max sequence length: {args.max_sequence_length}")
    print(f"[Export] FP16: {use_fp16}")
    print(f"[Export] ================================================")

    # Create output directory
    os.makedirs(args.output_dir, exist_ok=True)

    # Step 1: Load model
    model = load_model(args.model)

    # Step 2: Extract vocabulary
    print(f"[Export] Extracting vocabulary...")
    vocab = extract_vocabulary(model)
    print(f"[Export] Vocabulary size: {len(vocab)} tokens (+ blank = {len(vocab) + 1})")

    # Get encoder dimension
    encoder_dim = model.encoder.d_model if hasattr(model.encoder, "d_model") else 512
    print(f"[Export] Encoder dimension: {encoder_dim}")

    # Step 3: Export to ONNX
    encoder_onnx = os.path.join(args.output_dir, "encoder.onnx")
    decoder_onnx = os.path.join(args.output_dir, "decoder.onnx")

    export_encoder_onnx(model, encoder_onnx, args.max_sequence_length)
    export_decoder_onnx(model, decoder_onnx, args.max_sequence_length)

    # Step 4: Build TensorRT engines
    engine_path = os.path.join(args.output_dir, "model.engine")
    encoder_engine, decoder_engine = build_tensorrt_engine(
        encoder_onnx, decoder_onnx, engine_path, args.max_sequence_length, use_fp16
    )

    # Step 5: Save metadata
    save_metadata(
        args.output_dir, args.model, vocab, encoder_dim, args.max_sequence_length, use_fp16
    )

    print(f"[Export] ================================================")
    print(f"[Export] Export complete!")
    print(f"[Export] Output files:")
    for f in sorted(os.listdir(args.output_dir)):
        fpath = os.path.join(args.output_dir, f)
        if os.path.isfile(fpath):
            size = os.path.getsize(fpath)
            if size > 1e6:
                print(f"[Export]   {f} ({size / 1e6:.1f}MB)")
            else:
                print(f"[Export]   {f} ({size / 1e3:.1f}KB)")
    print(f"[Export] ================================================")


if __name__ == "__main__":
    main()
