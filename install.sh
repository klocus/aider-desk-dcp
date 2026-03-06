#!/bin/bash

set -e

REPO_URL="https://github.com/klocus/aider-desk-dcp/archive/refs/heads/master.zip"
ORIGINAL_DIR="$PWD"
TEMP_DIR=$(mktemp -d)
TRAP_CLEANUP() { rm -rf "$TEMP_DIR"; }
trap TRAP_CLEANUP EXIT

echo "Downloading AiderDesk DCP extension..."
cd "$TEMP_DIR"

if command -v curl &> /dev/null; then
    curl -fsSL "$REPO_URL" -o repo.zip
elif command -v wget &> /dev/null; then
    wget -q "$REPO_URL" -O repo.zip
else
    echo "Error: Neither curl nor wget is installed."
    exit 1
fi

echo "Extracting..."
unzip -q repo.zip

SCRIPT_DIR="aider-desk-dcp-master"

# Parse arguments
TARGET_DIR=""

if [ "$1" = "--global" ] || [ "$1" = "-g" ]; then
    TARGET_DIR="$HOME/.aider-desk/extensions"
    echo "Installing globally..."
else
    # Default: local installation
    TARGET_DIR="$ORIGINAL_DIR/.aider-desk/extensions"
    echo "Installing locally..."
fi

# Create extensions directory
mkdir -p "$TARGET_DIR"

# Copy DCP directory
echo "Copying DCP extension..."
DCP_DIR="$TEMP_DIR/$SCRIPT_DIR/dcp"
if [ ! -d "$DCP_DIR" ]; then
    echo "Error: DCP directory not found in downloaded archive."
    exit 1
fi

if [ -d "${TARGET_DIR}/dcp" ]; then
    echo "Existing DCP extension found. Removing..."
    rm -rf "${TARGET_DIR}/DCP"
fi

cp -R "$DCP_DIR" "${TARGET_DIR}/"

# Success message
echo ""
echo "✓ DCP extension installed successfully!"
echo "  Location: ${TARGET_DIR}/dcp"
