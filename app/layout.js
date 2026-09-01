import './globals.css';

export const metadata = {
  title: 'Concord TrackSync | Production Tracking System',
  description:
    'Concord TrackSync - Production Tracking System for Concord Footwear (Pvt) Ltd. Secure sign in and registration for department users.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans">{children}</body>
    </html>
  );
}
