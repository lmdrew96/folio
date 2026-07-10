import { ImageResponse } from "next/og";
import { folioIconElement } from "@/lib/pwa-icon";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// iOS applies its own corner rounding — the glyph itself must stay square
// and full-bleed, so this reuses the maskable (unrounded) variant.
export default function AppleIcon() {
  return new ImageResponse(
    folioIconElement({ size: 180, maskable: true }),
    size,
  );
}
