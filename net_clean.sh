#! /bin/bash
# Remove all virtual macvlan interfaces created by rtsp-to-onvif
for dev in $(ip -o link show | awk -F': ' '{print $2}' | grep '^rtsp2onvif_'); do
    sudo ip link del dev "$dev"
done
