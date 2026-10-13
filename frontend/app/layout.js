import './globals.css';

export const metadata = { title: 'Fire Monitoring Control Room' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
