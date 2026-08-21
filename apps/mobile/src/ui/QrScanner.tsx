/**
 * Native placeholder for the QR scanner.
 *
 * Scanning only exists on the receiving side, and the receiving side is the
 * browser: the native app is the one that *shows* the code. Metro picks
 * QrScanner.web.tsx on web and this file everywhere else, so nothing native
 * ever has to pull in a camera dependency it would not use.
 */

import { Body, Card, EmptyState } from './components';

export interface QrScannerProps {
  onResult: (text: string) => void;
  onCancel: () => void;
}

export function QrScanner(_props: QrScannerProps) {
  return (
    <Card>
      <EmptyState
        title="Scannen gibt es nur im Browser"
        hint="Diese App zeigt den Code, sie liest ihn nicht. Zum Koppeln öffne die Web-Ansicht auf dem anderen Gerät."
      />
      <Body muted style={{ fontSize: 12 }}>
        Gerät koppeln findest du unter Verbindung.
      </Body>
    </Card>
  );
}
