import './globals.css';
import type { ReactNode } from 'react';

export const metadata = { title: 'Stora Launch Copilot', description: 'A multi-agent copilot that gets your app store-ready.' };

export default function Root({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
