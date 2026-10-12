#!/bin/sh
# Regenerates the menu-bar template PNGs (assets/tray/*.png) from their SVG
# sources using ImageMagick only. qlmanage pads non-square SVGs onto a white
# square, and ImageMagick's SVG delegate needs librsvg (not installed), so the
# path data is extracted from each SVG and rasterized directly with MVG
# drawing: supersampled 8x, then Lanczos-downscaled to the exact menulet
# canvases (23x16 at 1x, 46x32 at 2x — naturally wide, not a padded square).
# Both variants share one canvas so the idle↔live swap never shifts.
#
# Usage: scripts/render-tray-icons.sh   (run from anywhere; needs `magick`)

set -e
cd "$(dirname "$0")/.."
SS=8            # supersample factor for the master render
W=46; H=32      # @2x canvas; the 1x file is a /2 downscale of the same master

render() { # $1 = svg path, $2 = output basename (e.g. flowTemplate)
	svg=$1; out=$2
	vb=$(sed -n 's/.*viewBox="\([^"]*\)".*/\1/p' "$svg")
	d=$(tr '\n' ' ' < "$svg" | sed -n 's/.*d="\([^"]*\)".*/\1/p' | tr -s ' ')
	sw=$(sed -n 's/.*stroke-width="\([^"]*\)".*/\1/p' "$svg")
	[ -n "$vb" ] && [ -n "$d" ] && [ -n "$sw" ] || { echo "cannot parse $svg" >&2; exit 1; }

	set -- $vb; x0=$1; y0=$2; w=$3; h=$4
	sx=$(awk "BEGIN{printf \"%.6f\", $W/$w}")
	sy=$(awk "BEGIN{printf \"%.6f\", $H/$h}")
	tx=$(awk "BEGIN{printf \"%.6f\", -$x0*$sx}")
	ty=$(awk "BEGIN{printf \"%.6f\", -$y0*$sy}")
	# The affine maps viewBox units onto the supersampled canvas AND scales the
	# stroke with them, so the stroke width stays in viewBox units: sw*sx then
	# lands as that many px on the @2x canvas (verified: an x2 affine doubled a
	# 20px strokewidth to 41px).
	affine=$(awk "BEGIN{printf \"%.4f,0,0,%.4f,%.4f,%.4f\", $sx*$SS, $sy*$SS, $tx*$SS, $ty*$SS}")
	magick -size $((W*SS))x$((H*SS)) xc:none \
		-stroke '#000' -strokewidth "$sw" -fill none \
		-draw "stroke-linecap round affine $affine path '$d'" \
		-filter Lanczos -resize "${W}x${H}!" "PNG32:assets/tray/${out}@2x.png"
	magick "assets/tray/${out}@2x.png" -filter Lanczos -resize "$((W/2))x$((H/2))!" "PNG32:assets/tray/${out}.png"
	echo "rendered assets/tray/${out}.png ($((W/2))x$((H/2))) + @2x (${W}x${H}) from $svg"
}

render assets/tray/flow-template.svg flowTemplate
render assets/tray/flow-live-template.svg flowLiveTemplate
