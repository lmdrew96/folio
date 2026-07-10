import { ImageResponse } from "next/og";
import { folioIconElement } from "@/lib/pwa-icon";

export const size = { width: 48, height: 48 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(folioIconElement({ size: 48 }), size);
}
