import { ImageResponse } from "next/og";
import { folioIconElement } from "@/lib/pwa-icon";

export const dynamic = "force-static";

export function GET() {
  return new ImageResponse(folioIconElement({ size: 512 }), {
    width: 512,
    height: 512,
  });
}
