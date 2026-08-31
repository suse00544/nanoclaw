import { useEffect, useRef, type CSSProperties, type VideoHTMLAttributes } from 'react';

type TadaAlphaVideoProps = Omit<
  VideoHTMLAttributes<HTMLVideoElement>,
  'aria-label' | 'children' | 'src'
> & {
  movSrc: string;
  webmSrc: string;
  decorative?: boolean;
  label?: string;
};

export function TadaAlphaVideo({
  movSrc,
  webmSrc,
  decorative = true,
  label,
  autoPlay = true,
  loop = true,
  preload = 'metadata',
  style,
  ...videoProps
}: TadaAlphaVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const syncMotion = () => {
      if (media.matches) {
        video.pause();
        video.currentTime = 0;
      } else if (autoPlay) {
        void video.play().catch(() => undefined);
      }
    };
    syncMotion();
    media.addEventListener('change', syncMotion);
    return () => media.removeEventListener('change', syncMotion);
  }, [autoPlay]);

  const transparentStyle: CSSProperties = {
    display: 'block',
    background: 'transparent',
    ...style,
  };

  return (
    <video
      {...videoProps}
      ref={videoRef}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : label}
      autoPlay={autoPlay}
      loop={loop}
      muted
      playsInline
      preload={preload}
      style={transparentStyle}
    >
      <source src={movSrc} type={'video/quicktime; codecs="hvc1"'} />
      <source src={webmSrc} type={'video/webm; codecs="vp9"'} />
    </video>
  );
}

