/**
 * Shared glyph for every generated app icon (favicon, apple-icon, manifest
 * icons). A single off-white "page" on a deep-violet ground — no custom font
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
        background: "#572F48",
        borderRadius: maskable ? 0 : size * 0.22,
      }}
    >
      <div
        style={{
          width: pageWidth,
          height: pageHeight,
          background: "#fff6f2",
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
            background: "#4E4C5E",
          }}
        />
        <div
          style={{
            width: "70%",
            height: size * 0.035,
            borderRadius: size * 0.02,
            background: "#d9d7d1",
          }}
        />
      </div>
    </div>
  );
}
