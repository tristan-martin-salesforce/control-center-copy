// Dev-only gallery for the chat dock (FE-1d). Brand tokens come from app/globals.css (brand.css).
import { ChatKit } from './ChatKit';

export const metadata = { title: 'Chat kit · Command Center' };

export default function ChatKitPage() {
  return <ChatKit />;
}
