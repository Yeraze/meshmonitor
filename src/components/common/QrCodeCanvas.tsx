import React, { useEffect, useRef } from 'react';
import QRCode from 'qrcode';

interface QrCodeCanvasProps {
  value: string;
  size?: number;
  className?: string;
  ariaLabel?: string;
  darkColor?: string;
  lightColor?: string;
  onError?: (error: Error) => void;
}

/**
 * Render a URL into an existing canvas using the app's installed QR encoder.
 * Consumers own the surrounding layout and explanatory text.
 */
export const QrCodeCanvas: React.FC<QrCodeCanvasProps> = ({
  value,
  size = 256,
  className,
  ariaLabel = 'QR code',
  darkColor = '#000000',
  lightColor = '#ffffff',
  onError,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    if (!value || !canvasRef.current) return;

    void QRCode.toCanvas(canvasRef.current, value, {
      width: size,
      margin: 2,
      color: {
        dark: darkColor,
        light: lightColor,
      },
    }).catch((error: unknown) => {
      onErrorRef.current?.(
        error instanceof Error ? error : new Error('Failed to generate QR code'),
      );
    });
  }, [value, size, darkColor, lightColor]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      role="img"
      aria-label={ariaLabel}
    />
  );
};
