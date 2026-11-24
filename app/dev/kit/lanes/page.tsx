// Dev-only spec for the kit's LanePage (the two-column page frame; Activity-at-scale AX-8). 404 outside `next dev`.
import { notFound } from 'next/navigation';
import { LanesKit } from './LanesKit';

export const metadata = { title: 'Lanes kit · Command Center' };

export default function LanesKitPage() {
  if (process.env.NODE_ENV !== 'development') notFound();
  return <LanesKit />;
}
