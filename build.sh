#!/bin/bash
set -e

# Build + rpm package: npm run pack-prod -- rpm
# Package will be in e.g. dist/packages/tuxedo-control-center_X.Y.Z.rpm

git_repo="$HOME/git/tuxedo/tuxedo-control-center"
tcc_opt_dir="/opt/tuxedo-control-center/resources/dist/tuxedo-control-center/data/dist-data"
desktop_file="$tcc_opt_dir/tuxedo-control-center.desktop"

# Clean old packages so the glob always points to the newly built package
rm -f "$git_repo"/dist/packages/*.rpm

# Build RPM package
npm run pack-prod -- rpm

# Locate the newly generated RPM
rpm_file=$(ls -t "$git_repo"/dist/packages/tuxedo-control-center_*.rpm 2>/dev/null | head -n1)
if [ ! -f "$rpm_file" ]; then
    echo "Error: RPM package not found in dist/packages/"
    exit 1
fi

echo "Installing $rpm_file..."
sudo dnf versionlock delete tuxedo-control-center 2>/dev/null || true
sudo dnf install --reinstall -y "$rpm_file"
sudo dnf versionlock add tuxedo-control-center 2>/dev/null || true

# Backup and link inside /opt in case package assets are referenced
if [ ! -f "$desktop_file.bak" ]; then
    echo "Backing up existing .desktop file..."
    sudo mv "$desktop_file"{,.bak} 2>/dev/null || true
fi
sudo ln -sf "$git_repo/tuxedo-control-center_ale-custom.desktop" "$desktop_file"

# Ensure user application menu and autostart point to custom script
mkdir -p "$HOME/.local/share/applications" "$HOME/.config/autostart"
ln -sf "$git_repo/tuxedo-control-center_ale-custom.desktop" "$HOME/.local/share/applications/tuxedo-control-center.desktop"
ln -sf "$git_repo/tuxedo-control-center_ale-custom.desktop" "$HOME/.config/autostart/tuxedo-control-center.desktop"
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true

ls -l "$tcc_opt_dir/"

echo -e "\nDone! TCC installed and custom desktop overrides linked."
