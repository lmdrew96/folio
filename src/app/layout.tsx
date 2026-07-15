import type { Metadata, Viewport } from "next";
import { Fraunces, Space_Grotesk, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ClerkProvider } from "@clerk/nextjs";
import ConvexClientProvider from "@/components/ConvexClientProvider";
import { ThemeProvider } from "@/components/ThemeProvider";
import { PWA } from "@/components/PWA";

// Folio's writing surface is the serif. Fraunces is Nae's brand display face;
// here it carries the prose body. SOFT/WONK axes give the brand's optical look.
const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  axes: ["opsz", "SOFT", "WONK"],
  display: "swap",
});

// Chrome (header, panels, buttons) stays in the brand sans — contrast with the
// prose serif is the point.
const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Folio",
  description: "A writing space that knows what changed since you last looked.",
  appleWebApp: {
    title: "Folio",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f9f1eb" },
    { media: "(prefers-color-scheme: dark)", color: "#20161e" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider>
      <html
        lang="en"
        suppressHydrationWarning
        className={`${fraunces.variable} ${spaceGrotesk.variable} ${geistMono.variable} h-full antialiased`}
      >
        <body className="min-h-full flex flex-col">
          <ThemeProvider>
            <ConvexClientProvider>{children}</ConvexClientProvider>
            <PWA />
          </ThemeProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
