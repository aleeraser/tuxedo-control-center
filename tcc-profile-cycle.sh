#!/bin/bash

# Define the exact IDs of the 3 profiles you want to cycle between, in order.
# You can change these IDs to match your preferred profiles.
CYCLE_PROFILES=(
  "max_power_custom_profile"
  "medium_power_custom_profile"
  "low_power_custom_profile"
)

# Fetch the current active profile ID from TCCD
# Note: dbus-send wraps the JSON string across multiple lines; awk reassembles it before jq parses it.
ACTIVE_PROFILE=$(dbus-send --system --print-reply --dest=com.tuxedocomputers.tccd /com/tuxedocomputers/tccd com.tuxedocomputers.tccd.GetActiveProfileJSON \
  | awk '/string "/{p=1; sub(/.*string "/, ""); buf=$0; next} p{buf=buf $0} END{sub(/"$/, "", buf); print buf}' \
  | jq -r '.id')

# Find the index of the currently active profile within our custom array
CURRENT_INDEX=-1
for i in "${!CYCLE_PROFILES[@]}"; do
   if [[ "${CYCLE_PROFILES[$i]}" == "${ACTIVE_PROFILE}" ]]; then
       CURRENT_INDEX=$i
       break
   fi
done

# Calculate the index of the next profile (wrap back to 0 if at the end)
# If the current profile isn't in our array (CURRENT_INDEX == -1), it defaults to the first one (index 0).
NEXT_INDEX=$(( (CURRENT_INDEX + 1) % ${#CYCLE_PROFILES[@]} ))

# Get the ID of the next profile
NEXT_PROFILE_ID="${CYCLE_PROFILES[$NEXT_INDEX]}"

# Apply the new profile
dbus-send --system --print-reply --dest=com.tuxedocomputers.tccd /com/tuxedocomputers/tccd com.tuxedocomputers.tccd.SetTempProfileById string:"$NEXT_PROFILE_ID" > /dev/null

# Trigger power optimization hook asynchronously for instant transition
if [[ "$NEXT_PROFILE_ID" == "low_power_custom_profile" ]]; then
  ~/.local/bin/tcc-power-hook --low >/dev/null 2>&1 &
else
  ~/.local/bin/tcc-power-hook --restore >/dev/null 2>&1 &
fi

# Display on-screen OSD notification
case "$NEXT_PROFILE_ID" in
  "max_power_custom_profile")
    TITLE="⚡ Max Power"
    DESC="PL1: 185W · PL2: 210W · Custom Fan"
    ICON="power-profile-performance"
    ;;
  "medium_power_custom_profile")
    TITLE="⚖️ Medium Power"
    DESC="PL1: 80W · PL2: 80W · Balanced Fan"
    ICON="power-profile-balanced"
    ;;
  "low_power_custom_profile")
    TITLE="🌱 Low Power"
    DESC="PL1: 15W · PL2: 20W · Quiet Fan"
    ICON="power-profile-power-saver"
    ;;
  *)
    TITLE="TCC Profile Changed"
    DESC="$NEXT_PROFILE_ID"
    ICON="preferences-system-power"
    ;;
esac

notify-send -a "TUXEDO Control Center" \
  -i "$ICON" \
  -h string:x-canonical-private-synchronous:tcc-profile \
  -t 1800 \
  "$TITLE" "$DESC" 2>/dev/null || true
