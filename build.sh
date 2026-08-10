#!/bin/bash

# Build + rpm package: npm run pack-prod -- rpm
# Package will be in e.g. dist/packages/tuxedo-control-center_X.Y.Z.rpm

git_repo="$HOME/git/tuxedo/tuxedo-control-center"
tcc_opt_dir="/opt/tuxedo-control-center/resources/dist/tuxedo-control-center/data/dist-data"
desktop_file="$tcc_opt_dir/tuxedo-control-center.desktop"

check_err() {
    if [ "$1" -ne 0 ]; then
        echo "Error, aborting..."
        exit $1
    fi
}

npm run pack-prod -- rpm
check_err $?

sudo dnf versionlock delete tuxedo-control-center
sudo dnf reinstall $git_repo/dist/packages/tuxedo-control-center_*.rpm
check_err $?
sudo dnf versionlock add tuxedo-control-center

if [ ! -f "$desktop_file.bak" ]; then
    echo "Backing up existing .desktop file..."
    sudo mv $desktop_file{,.bak}
    check_err $?
else
    echo "Skipping .desktop file backup, already exists: $desktop_file.bak"
fi

sudo ln -sf $git_repo/tuxedo-control-center_ale-custom.desktop $desktop_file
check_err $?

ls -l $tcc_opt_dir/

echo -e "\nDone!"
