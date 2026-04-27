import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "@stream-io/video-react-sdk/dist/css/styles.css";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "NULLXES HR AI",
  description: "NULLXES HR interview system",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" className={`${geistSans.variable} ${geistMono.variable} h-full min-w-0 antialiased`}>
      <body className="flex min-h-full min-w-0 flex-col touch-manipulation">
        <TooltipProvider>
          {children}
          <Toaster richColors position="top-center" />
          <Analytics />
        </TooltipProvider>
      </body>
    </html>
  );
}
