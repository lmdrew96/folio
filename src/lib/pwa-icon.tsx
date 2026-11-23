/**
 * Shared glyph for every generated app icon (favicon, apple-icon, manifest
 * icons). A Squid Ink "page" on the sea-dark desk — no custom font
 * loading, so it stays well under ImageResponse's 500KB bundle limit.
 *
 * `maskable` drops the self-rounding and shrinks the glyph so Android's own
 * mask (circle, squircle, …) never clips it — see the maskable icon spec.
 */
export function folioIconElement({
  size,
  maskable = false,
}: {
  size: number;
  maskable?: boolean;
}) {
  const pageInset = maskable ? size * 0.28 : size * 0.18;
  const pageWidth = size - pageInset * 2;
  const pageHeight = pageWidth * 1.24;

  return (
    <div
      style={{
        width: size,
        height: size,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0f1a1c",
        borderRadius: maskable ? 0 : size * 0.22,
      }}
    >
      <div
        style={{
          width: pageWidth,
          height: pageHeight,
          background: "#1f3135",
          borderRadius: size * 0.045,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: size * 0.05,
          padding: `0 ${size * 0.09}px`,
        }}
      >
        <div
          style={{
            width: "100%",
            height: size * 0.035,
            borderRadius: size * 0.02,
            background: "#f08a6e",
          }}
        />
        <div
          style={{
            width: "70%",
            height: size * 0.035,
            borderRadius: size * 0.02,
            background: "#7fb0d6",
          }}
        />
      </div>
    </div>
  );
}
