import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Folio",
    short_name: "Folio",
    description:
      "A writing space that knows what changed since you last looked.",
    start_url: "/",
    display: "standalone",
    background_color: "#0f1a1c",
    theme_color: "#0f1a1c",
    icons: [
      { src: "/icons/192", sizes: "192x192", type: "image/png" },
      { src: "/icons/512", sizes: "512x512", type: "image/png" },
      {
        src: "/icons/512-maskable",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
