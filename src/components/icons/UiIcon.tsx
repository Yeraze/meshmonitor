import type { CSSProperties } from 'react';
import {
  Accessibility,
  Activity,
  AirVent,
  AlarmClock,
  AlertTriangle,
  Archive,
  ArrowDownToLine,
  ArrowDown,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowUp,
  ArrowUpFromLine,
  BarChart3,
  Beaker,
  Battery,
  BatteryCharging,
  Ban,
  Bell,
  Bot,
  Calendar,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleDashed,
  CircleDot,
  CircleHelp,
  CircleX,
  ClipboardList,
  Clock,
  CloudSun,
  Code2,
  Copy,
  Crosshair,
  Database,
  Download,
  Edit3,
  Eye,
  EyeOff,
  File,
  FileCode2,
  Filter,
  Home,
  Heart,
  IdCard,
  Import,
  Info,
  KeyRound,
  Laptop,
  LayoutDashboard,
  Link,
  List,
  Lock,
  LockKeyhole,
  Mail,
  Map,
  MapPin,
  Menu,
  Megaphone,
  MessageCircle,
  MessageSquare,
  Monitor,
  MoreVertical,
  Mountain,
  Network,
  Newspaper,
  Package,
  Pause,
  Pin,
  Play,
  Plus,
  Power,
  Radio,
  RadioTower,
  RefreshCw,
  Reply,
  Route,
  Ruler,
  Satellite,
  Save,
  Search,
  Send,
  Server,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Smile,
  Sparkles,
  Star,
  Sun,
  Terminal,
  Thermometer,
  Timer,
  Trash2,
  Trophy,
  Type,
  Unlock,
  Upload,
  User,
  Users,
  Volume2,
  VolumeX,
  Wifi,
  Wind,
  Wrench,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useIconStyleOptional, type IconStyle } from '../../contexts/IconStyleContext';

export interface UiIconDefinition {
  lucide: LucideIcon;
  emoji: string;
  usage: string;
}

/**
 * The single presentation vocabulary for app-owned icons. Domain/content emoji
 * (messages, tapbacks, waypoints, scripts, protocol templates) deliberately do
 * not belong here.
 */
// eslint-disable-next-line react-refresh/only-export-components -- #4215 registry is exported for typed callers and catalog tests
export const UI_ICON_DEFINITIONS = {
  accessibility: { lucide: Accessibility, emoji: '♿️', usage: 'accessibility and inclusive design' },
  activity: { lucide: Activity, emoji: '📈', usage: 'packet and activity monitoring' },
  airQuality: { lucide: AirVent, emoji: '💨', usage: 'air-quality telemetry' },
  alarm: { lucide: AlarmClock, emoji: '⏰', usage: 'scheduled and timed actions' },
  announcement: { lucide: Megaphone, emoji: '📢', usage: 'announcements and notification sources' },
  alert: { lucide: AlertTriangle, emoji: '⚠️', usage: 'warnings and security risks' },
  altitude: { lucide: Mountain, emoji: '⛰️', usage: 'altitude and elevation' },
  archive: { lucide: Archive, emoji: '🗄️', usage: 'archives and retained data' },
  back: { lucide: ArrowLeft, emoji: '⬅️', usage: 'back navigation' },
  battery: { lucide: Battery, emoji: '🔋', usage: 'battery state' },
  batteryCharging: { lucide: BatteryCharging, emoji: '🔌', usage: 'external power and charging' },
  bidirectional: { lucide: ArrowLeftRight, emoji: '↔️', usage: 'bidirectional links' },
  bot: { lucide: Bot, emoji: '🤖', usage: 'automations and auto responders' },
  blocked: { lucide: Ban, emoji: '🚫', usage: 'ignored and blocked state' },
  calendar: { lucide: Calendar, emoji: '📅', usage: 'dates and longer mute durations' },
  channels: { lucide: MessageSquare, emoji: '💬', usage: 'channels' },
  check: { lucide: Check, emoji: '✅', usage: 'success and enabled state' },
  checkAll: { lucide: CheckCheck, emoji: '✅', usage: 'delivered and fully acknowledged state' },
  chevronDown: { lucide: ChevronDown, emoji: '▼️', usage: 'expanded menus' },
  chevronUp: { lucide: ChevronUp, emoji: '▲️', usage: 'collapsed menus' },
  close: { lucide: X, emoji: '✕', usage: 'close and remove controls' },
  code: { lucide: Code2, emoji: '💻', usage: 'source code and scripts' },
  companion: { lucide: Smartphone, emoji: '📱', usage: 'MeshCore companion role' },
  configuration: { lucide: Satellite, emoji: '📡', usage: 'device configuration' },
  copy: { lucide: Copy, emoji: '📋', usage: 'copy actions' },
  database: { lucide: Database, emoji: '🗃️', usage: 'database operations' },
  dashboard: { lucide: LayoutDashboard, emoji: '📊', usage: 'dashboards' },
  delete: { lucide: Trash2, emoji: '🗑️', usage: 'delete, clear, and purge actions' },
  directMessages: { lucide: Mail, emoji: '📧', usage: 'direct messages' },
  download: { lucide: Download, emoji: '📥', usage: 'downloads and exports' },
  edit: { lucide: Edit3, emoji: '✏️', usage: 'edit actions' },
  encrypted: { lucide: Lock, emoji: '🔒', usage: 'encrypted and locked state' },
  encryptedKey: { lucide: LockKeyhole, emoji: '🔐', usage: 'secure key state' },
  error: { lucide: CircleX, emoji: '❌', usage: 'errors and failed state' },
  favorite: { lucide: Star, emoji: '⭐', usage: 'favorites and primary items' },
  favoriteOff: { lucide: Star, emoji: '☆', usage: 'not-favorited state' },
  file: { lucide: File, emoji: '📄', usage: 'files' },
  fileCode: { lucide: FileCode2, emoji: '📄', usage: 'script files' },
  filter: { lucide: Filter, emoji: '🔍', usage: 'filter controls' },
  forward: { lucide: ArrowRight, emoji: '➡️', usage: 'forward navigation' },
  help: { lucide: CircleHelp, emoji: '❓', usage: 'help and unknown state' },
  heart: { lucide: Heart, emoji: '❤️', usage: 'support and appreciation' },
  home: { lucide: Home, emoji: '🏠', usage: 'home and room-server role' },
  identity: { lucide: IdCard, emoji: '🆔', usage: 'node identifiers' },
  import: { lucide: Import, emoji: '📥', usage: 'imports' },
  info: { lucide: Info, emoji: 'ℹ️', usage: 'information' },
  key: { lucide: KeyRound, emoji: '🔑', usage: 'keys and identity exchange' },
  laptop: { lucide: Laptop, emoji: '🖥️', usage: 'client and hardware details' },
  link: { lucide: Link, emoji: '🔗', usage: 'links and mesh hops' },
  list: { lucide: List, emoji: '📜', usage: 'history and lists' },
  location: { lucide: MapPin, emoji: '📍', usage: 'position and location' },
  map: { lucide: Map, emoji: '🗺️', usage: 'maps and topology' },
  menu: { lucide: Menu, emoji: '☰', usage: 'navigation menus' },
  messages: { lucide: MessageCircle, emoji: '💬', usage: 'messages and replies' },
  more: { lucide: MoreVertical, emoji: '⋮', usage: 'more-actions menus' },
  monitor: { lucide: Monitor, emoji: '🖥️', usage: 'devices and displays' },
  muted: { lucide: VolumeX, emoji: '🔇', usage: 'muted notifications' },
  network: { lucide: Network, emoji: '🌐', usage: 'network and MQTT state' },
  news: { lucide: Newspaper, emoji: '📰', usage: 'news' },
  nodes: { lucide: Map, emoji: '🗺️', usage: 'nodes navigation' },
  notifications: { lucide: Bell, emoji: '🔔', usage: 'notifications' },
  package: { lucide: Package, emoji: '📦', usage: 'packets, packages, and store-forward' },
  pause: { lucide: Pause, emoji: '⏸️', usage: 'pause controls' },
  pin: { lucide: Pin, emoji: '📌', usage: 'pinning and sticky state' },
  play: { lucide: Play, emoji: '▶️', usage: 'play and resume controls' },
  plus: { lucide: Plus, emoji: '➕', usage: 'add and create controls' },
  power: { lucide: Power, emoji: '⚡', usage: 'power controls' },
  radio: { lucide: Radio, emoji: '📻', usage: 'MeshCore and radio state' },
  // Three-state status dots (#4217 follow-up). Emoji counterparts are the
  // glyphs these replaced, so emoji-mode users see exactly what they saw before.
  statusOn: { lucide: CircleDot, emoji: '●', usage: 'active / connected / live status' },
  statusPartial: { lucide: CircleDashed, emoji: '◐', usage: 'partial or pending status' },
  statusOff: { lucide: Circle, emoji: '○', usage: 'inactive / disconnected status' },
  radioSignal: { lucide: RadioTower, emoji: '📡', usage: 'RSSI, reception, and traceroutes' },
  reaction: { lucide: Smile, emoji: '😄', usage: 'reactions and tapbacks' },
  refresh: { lucide: RefreshCw, emoji: '🔄', usage: 'refresh, reload, and reboot' },
  repeater: { lucide: Radio, emoji: '📡', usage: 'MeshCore repeater role' },
  reports: { lucide: ClipboardList, emoji: '📋', usage: 'reports and audit logs' },
  reply: { lucide: Reply, emoji: '↩️', usage: 'reply actions' },
  route: { lucide: Route, emoji: '🔀', usage: 'routes and traceroutes' },
  ruler: { lucide: Ruler, emoji: '📏', usage: 'distance' },
  save: { lucide: Save, emoji: '💾', usage: 'save actions' },
  search: { lucide: Search, emoji: '🔍', usage: 'search and scan actions' },
  send: { lucide: Send, emoji: '➡️', usage: 'send-message actions' },
  security: { lucide: Shield, emoji: '🛡️', usage: 'security' },
  securityAlert: { lucide: ShieldAlert, emoji: '⚠️', usage: 'security alerts' },
  securityCheck: { lucide: ShieldCheck, emoji: '🛡️', usage: 'verified security state' },
  sensor: { lucide: Thermometer, emoji: '🌡️', usage: 'MeshCore sensor role' },
  server: { lucide: Server, emoji: '🖥️', usage: 'servers and services' },
  settings: { lucide: Settings, emoji: '⚙️', usage: 'settings' },
  sparkles: { lucide: Sparkles, emoji: '✨', usage: 'new and featured items' },
  sun: { lucide: Sun, emoji: '☀️', usage: 'weather and solar data' },
  telemetry: { lucide: BarChart3, emoji: '📊', usage: 'telemetry and charts' },
  test: { lucide: Beaker, emoji: '🧪', usage: 'test and validation actions' },
  text: { lucide: Type, emoji: '🔤', usage: 'text and keyword filters' },
  target: { lucide: Crosshair, emoji: '🎯', usage: 'centering and position accuracy' },
  terminal: { lucide: Terminal, emoji: '💻', usage: 'console and shell actions' },
  time: { lucide: Clock, emoji: '🕐', usage: 'time and last-heard state' },
  timer: { lucide: Timer, emoji: '⏱️', usage: 'timeouts and durations' },
  trophy: { lucide: Trophy, emoji: '🏆', usage: 'records and achievements' },
  unencrypted: { lucide: Eye, emoji: '🔓', usage: 'unencrypted and visible state' },
  unlock: { lucide: Unlock, emoji: '🔓', usage: 'unlock actions' },
  unmute: { lucide: Volume2, emoji: '🔔', usage: 'enabled notification audio' },
  upload: { lucide: Upload, emoji: '📤', usage: 'uploads and imports' },
  user: { lucide: User, emoji: '👤', usage: 'a user or node owner' },
  users: { lucide: Users, emoji: '👥', usage: 'user administration' },
  visibility: { lucide: Eye, emoji: '👁️', usage: 'show sensitive or hidden values' },
  visibilityOff: { lucide: EyeOff, emoji: '🙈', usage: 'hidden state' },
  weather: { lucide: CloudSun, emoji: '☀️', usage: 'weather data' },
  wifi: { lucide: Wifi, emoji: '📶', usage: 'signal and SNR' },
  wind: { lucide: Wind, emoji: '💨', usage: 'air and wind data' },
  wrench: { lucide: Wrench, emoji: '🛠️', usage: 'administration and tools' },
  zap: { lucide: Zap, emoji: '⚡', usage: 'voltage and admin commands' },
  downloadData: { lucide: ArrowDownToLine, emoji: '📥', usage: 'data export' },
  uploadData: { lucide: ArrowUpFromLine, emoji: '📤', usage: 'data import' },
  sortAscending: { lucide: ArrowUp, emoji: '↑', usage: 'ascending sort' },
  sortDescending: { lucide: ArrowDown, emoji: '↓', usage: 'descending sort and jump-to-bottom' },
} as const satisfies Record<string, UiIconDefinition>;

export type UiIconName = keyof typeof UI_ICON_DEFINITIONS;

export interface UiIconProps {
  name: UiIconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
  title?: string;
  style?: CSSProperties;
  /** Intended for tests/catalog previews; normal callers use the global setting. */
  iconStyle?: IconStyle;
}

export function UiIcon({
  name,
  size = 18,
  strokeWidth = 2,
  className,
  title,
  style,
  iconStyle,
}: UiIconProps) {
  const contextStyle = useIconStyleOptional();
  const resolvedStyle = iconStyle ?? contextStyle ?? 'lucide';
  const definition = UI_ICON_DEFINITIONS[name];

  if (resolvedStyle === 'emoji') {
    return (
      <span
        data-ui-icon={name}
        className={className}
        role={title ? 'img' : undefined}
        aria-label={title}
        aria-hidden={title ? undefined : true}
        title={title}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: size,
          minWidth: size,
          height: size,
          fontSize: size,
          lineHeight: 1,
          ...style,
        }}
      >
        {definition.emoji}
      </span>
    );
  }

  const Lucide = definition.lucide;
  return (
    <Lucide
      data-ui-icon={name}
      className={className}
      size={size}
      strokeWidth={strokeWidth}
      fill={name === 'favorite' ? 'currentColor' : 'none'}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      style={style}
    />
  );
}
