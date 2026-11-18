import type { ReactNode } from 'react';
import Svg, { Circle, Path } from 'react-native-svg';

/** The web's toolbar icons (apps/web/src/components/ToolbarIcons.tsx), with the same paths: both apps draw the same. */
const Icon = ({ color, size = 18, children }: { color: string; size?: number; children: ReactNode }) => (
  <Svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </Svg>
);

export type IconProps = { color: string; size?: number };

/** A commit line: the document's revisions. */
export const HistoryIcon = (props: IconProps) => (
  <Icon {...props}>
    <Path d="M6 3v12" />
    <Circle cx="18" cy="6" r="3" />
    <Circle cx="6" cy="18" r="3" />
    <Path d="M18 9a9 9 0 0 1-9 9" />
  </Icon>
);

export const TrashIcon = (props: IconProps) => (
  <Icon {...props}>
    <Path d="M3 6h18" />
    <Path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <Path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <Path d="M10 11v6M14 11v6" />
  </Icon>
);

export const SaveIcon = (props: IconProps) => (
  <Icon {...props}>
    <Path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
    <Path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" />
    <Path d="M7 3v4a1 1 0 0 0 1 1h7" />
  </Icon>
);
