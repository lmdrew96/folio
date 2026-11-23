import type { Metadata, Viewport } from "next";
import {
  Literata,
  IM_Fell_English,
  Fraunces,
  Space_Grotesk,
  Geist_Mono,
  Newsreader,
  Lora,
  Source_Serif_4,
  Inter,
  Work_Sans,
  Manrope,
  JetBrains_Mono,
} from "next/font/google";
import "./globals.css";
import { ClerkProvider } from "@clerk/nextjs";
import ConvexClientProvider from "@/components/ConvexClientProvider";
import { ThemeProvider } from "@/components/ThemeProvider";
import { PWA } from "@/components/PWA";
import { UpdateToast } from "@/components/UpdateToast";
import { UserSync } from "@/components/UserSync";

// Folio's writing surface and chrome: Literata, with latin-ext for ă/ș/ț.
const literata = Literata({
  variable: "--font-literata",
  subsets: ["latin", "latin-ext"],
  style: ["normal", "italic"],
  axes: ["opsz"],
  display: "swap",
});

// Headings, titles and the wordmark. Google ships IM Fell English in Latin
// only; the font stack in globals.css falls back to Literata for the rest.
const imFell = IM_Fell_English({
  variable: "--font-im-fell",
  weight: "400",
  style: ["normal", "italic"],
  subsets: ["latin"],
  display: "swap",
});

// Fraunces and Space Grotesk were Folio's defaults before the Squid Ink
// theme; they stay on the per-document font list.
const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  axes: ["opsz", "SOFT", "WONK"],
  display: "swap",
});
const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// The rest of the curated prose-font list (src/lib/fonts.ts) — 3 more serif,
// 3 more sans, 1 more mono, loaded up front so picking one is just a CSS
// variable swap (--folio-prose-font) instead of a runtime font fetch.
const newsreader = Newsreader({ variable: "--font-newsreader", subsets: ["latin"], display: "swap" });
const lora = Lora({ variable: "--font-lora", subsets: ["latin"], display: "swap" });
const sourceSerif = Source_Serif_4({ variable: "--font-source-serif", subsets: ["latin"], display: "swap" });
const inter = Inter({ variable: "--font-inter", subsets: ["latin"], display: "swap" });
const workSans = Work_Sans({ variable: "--font-work-sans", subsets: ["latin"], display: "swap" });
const manrope = Manrope({ variable: "--font-manrope", subsets: ["latin"], display: "swap" });
const jetbrainsMono = JetBrains_Mono({ variable: "--font-jetbrains-mono", subsets: ["latin"], display: "swap" });

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
    { media: "(prefers-color-scheme: light)", color: "#e2eaea" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1a1c" },
  ],
  // The on-screen keyboard shrinks the page instead of covering it, so the
  // line being typed stays visible (BlockNote's mobile requirement).
  interactiveWidget: "resizes-content",
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
        className={`${literata.variable} ${imFell.variable} ${fraunces.variable} ${spaceGrotesk.variable} ${geistMono.variable} ${newsreader.variable} ${lora.variable} ${sourceSerif.variable} ${inter.variable} ${workSans.variable} ${manrope.variable} ${jetbrainsMono.variable} h-full antialiased`}
      >
        <body className="min-h-full flex flex-col">
          <ThemeProvider>
            <ConvexClientProvider>
              <UserSync />
              {children}
            </ConvexClientProvider>
            <PWA />
            <UpdateToast />
          </ThemeProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
