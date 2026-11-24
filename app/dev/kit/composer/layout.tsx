import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './kit.css';

export const metadata: Metadata = { title: 'Composer kit · Command Center' };

export default function KitLayout({ children }: { children: ReactNode }) {
  return children;
}
