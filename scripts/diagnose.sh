#!/usr/bin/env bash
# Quick network + media diagnostics for the screening room.
# Run this ON THE VPS: bash scripts/diagnose.sh
set -uo pipefail

MEDIA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../media" && pwd)"

echo "== TCP 拥塞控制算法 =="
sysctl net.ipv4.tcp_congestion_control 2>/dev/null || echo "无法读取（非 Linux？）"
echo "可用算法: $(sysctl -n net.ipv4.tcp_available_congestion_control 2>/dev/null || echo 未知)"
echo

echo "== 出口带宽粗测（VPS -> 公网，下载一个 100MB 测试文件）=="
if command -v curl >/dev/null; then
  curl -o /dev/null -s -w "%{time_total} %{speed_download}\n" http://speedtest.tele2.net/100MB.zip \
    | awk '{ printf "耗时 %.1fs，约 %.1f Mbps\n", $1, $2 * 8 / 1000000 }'
else
  echo "没有装 curl"
fi
echo

echo "== media/ 目录里各电影的码率 =="
if ! command -v ffprobe >/dev/null; then
  echo "没有装 ffprobe，先 apt install ffmpeg"
else
  for f in "$MEDIA_DIR"/*; do
    [ -f "$f" ] || continue
    base="$(basename "$f")"
    [[ "$base" == .* ]] && continue
    bitrate="$(ffprobe -v error -show_entries format=bit_rate -of default=noprint_wrappers=1:nokey=1 "$f" 2>/dev/null)"
    if [ -z "$bitrate" ] || [ "$bitrate" = "N/A" ]; then
      printf "%-40s 未知\n" "$base"
    else
      awk -v name="$base" -v b="$bitrate" 'BEGIN { printf "%-40s %.1f Mbps\n", name, b/1000000 }'
    fi
  done
fi
