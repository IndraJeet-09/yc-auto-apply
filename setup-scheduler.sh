#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_NAME="yc-auto-apply"

echo "Installing YC Auto Apply scheduler..."

mkdir -p "$SERVICE_DIR"
cp "$REPO_DIR/yc-auto-apply.service" "$SERVICE_DIR/"
cp "$REPO_DIR/yc-auto-apply.timer" "$SERVICE_DIR/"

systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME.timer"
systemctl --user start "$SERVICE_NAME.timer"

echo "Done! Timer installed and started."
echo "Schedule: daily at 18:30 IST (9:00 AM ET / 3:00 PM CET)"
echo ""
echo "Commands:"
echo "  systemctl --user status $SERVICE_NAME.timer    # check timer"
echo "  systemctl --user start $SERVICE_NAME.service    # run now"
echo "  systemctl --user stop $SERVICE_NAME.timer       # pause"
echo "  journalctl --user -u $SERVICE_NAME.service      # view logs"
