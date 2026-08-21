/**
 * QR scanner for the browser.
 *
 * Plain getUserMedia plus a pure-JS decoder — no native module, so this keeps
 * working in any browser that will hand over a camera. Metro loads this file
 * on web and QrScanner.tsx everywhere else.
 *
 * The camera is released on every exit path. A page that quietly keeps a
 * camera open after the user is done with it is the kind of thing people
 * notice by the indicator light, and rightly hold against you.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import jsQR from 'jsqr';

import { Body, Button, Card, ErrorBanner, SectionTitle, radius, spacing } from './components';
import { useTheme } from './theme';

export interface QrScannerProps {
  onResult: (text: string) => void;
  onCancel: () => void;
}

/** How often to look at a frame. Every frame is wasted work for a static code. */
const SCAN_INTERVAL_MS = 200;

export function QrScanner({ onResult, onCancel }: QrScannerProps) {
  const theme = useTheme();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setScanning(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const canvas = document.createElement('canvas');

    const start = async () => {
      const media = globalThis.navigator?.mediaDevices;
      if (!media?.getUserMedia) {
        setError('Dieser Browser gibt keine Kamera frei. Trag Adresse und Token von Hand ein.');
        return;
      }

      try {
        // The rear camera on a phone, whatever exists on a laptop.
        const stream = await media.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          video.setAttribute('playsinline', 'true');
          await video.play().catch(() => {});
        }
        setScanning(true);

        timer = setInterval(() => {
          const element = videoRef.current;
          if (!element || element.readyState !== element.HAVE_ENOUGH_DATA) return;

          canvas.width = element.videoWidth;
          canvas.height = element.videoHeight;
          const context = canvas.getContext('2d', { willReadFrequently: true });
          if (!context) return;

          context.drawImage(element, 0, 0, canvas.width, canvas.height);
          const image = context.getImageData(0, 0, canvas.width, canvas.height);
          const found = jsQR(image.data, image.width, image.height, {
            inversionAttempts: 'dontInvert',
          });
          if (found?.data) onResult(found.data);
        }, SCAN_INTERVAL_MS);
      } catch (err) {
        const name = (err as Error).name;
        setError(
          name === 'NotAllowedError'
            ? 'Die Kamera wurde abgelehnt. Erlaube sie in den Seiteneinstellungen, oder trag Adresse und Token von Hand ein.'
            : `Kamera nicht verfügbar: ${(err as Error).message}`,
        );
      }
    };

    void start();

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      stop();
    };
  }, [onResult, stop]);

  return (
    <Card>
      <SectionTitle>Code scannen</SectionTitle>
      {error ? <ErrorBanner message={error} /> : null}

      <View
        style={{
          borderRadius: radius.md,
          overflow: 'hidden',
          backgroundColor: theme.mono,
          aspectRatio: 1,
          maxHeight: 320,
        }}
      >
        {/* A DOM node in a react-native-web tree: this file only ever runs on
            web, where that is exactly what View renders into anyway. */}
        <video
          ref={videoRef}
          muted
          playsInline
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      </View>

      <Body muted style={{ fontSize: 13 }}>
        {scanning
          ? 'Halte die Kamera auf den Code in der Handy-App.'
          : 'Warte auf die Kamera…'}
      </Body>

      <Button
        label="Abbrechen"
        onPress={() => {
          stop();
          onCancel();
        }}
      />
    </Card>
  );
}
