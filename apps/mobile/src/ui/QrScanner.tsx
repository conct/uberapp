/**
 * The QR scanner, on a device with a camera.
 *
 * This used to be a placeholder that said scanning happens in the browser.
 * That was true while the phone showed the code and the browser read it; the
 * direction is the other way round now, because a desktop rarely has a camera
 * and is the wrong end to hold up to a screen. Metro still picks
 * QrScanner.web.tsx on web, where the browser's own getUserMedia is used.
 *
 * expo-camera does the decoding itself, so nothing here touches pixels.
 */

import { useRef, useState } from 'react';
import { View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';

import { Body, Button, Card, SectionTitle, radius } from './components';
import { useTheme } from './theme';

export interface QrScannerProps {
  onResult: (text: string) => void;
  onCancel: () => void;
}

export function QrScanner({ onResult, onCancel }: QrScannerProps) {
  const theme = useTheme();
  const [permission, requestPermission] = useCameraPermissions();

  /**
   * The camera reports the same code many times a second while it stays in
   * frame. Everything downstream — minting a token, depositing it — must
   * happen once, and a ref rather than state because the callback fires again
   * long before a re-render would have been observed.
   */
  const handled = useRef(false);
  const [busy, setBusy] = useState(false);

  if (!permission) {
    // Still being read; a spinner here would flash for one frame.
    return null;
  }

  if (!permission.granted) {
    return (
      <Card>
        <SectionTitle>Kamera</SectionTitle>
        <Body muted style={{ fontSize: 13 }}>
          {permission.canAskAgain
            ? 'Zum Scannen braucht die App Zugriff auf die Kamera. Sie wird nur währenddessen benutzt, und es wird nichts aufgezeichnet.'
            : 'Der Kamerazugriff ist abgelehnt. Du kannst ihn in den Android-Einstellungen unter Apps → uberCTRL → Berechtigungen wieder erlauben.'}
        </Body>
        {permission.canAskAgain ? (
          <Button
            label="Kamera erlauben"
            variant="primary"
            onPress={() => void requestPermission()}
          />
        ) : null}
        <Button label="Abbrechen" onPress={onCancel} />
      </Card>
    );
  }

  return (
    <Card>
      <SectionTitle>Code scannen</SectionTitle>
      <View
        style={{
          height: 280,
          borderRadius: radius.sm,
          overflow: 'hidden',
          backgroundColor: theme.surfaceAlt,
        }}
      >
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => {
            if (handled.current) return;
            handled.current = true;
            setBusy(true);
            onResult(data);
          }}
        />
      </View>

      <Body muted style={{ fontSize: 12 }}>
        {busy
          ? 'Code gelesen.'
          : 'Halte die Kamera auf den Code, den die Web-Ansicht am Rechner zeigt.'}
      </Body>

      <Button label="Abbrechen" onPress={onCancel} />
    </Card>
  );
}
