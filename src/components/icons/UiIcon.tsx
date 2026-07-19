import type { CSSProperties } from 'react';
import {
  Activity,
  AirVent,
  AlarmClock,
  AlertTriangle,
  Archive,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpFromLine,
  BarChart3,
  Battery,
  BatteryCharging,
  Bell,
  Bot,
  Check,
  CheckCheck,
  ChevronDown,
  CircleHelp,
  CircleX,
  ClipboardList,
  Clock,
  CloudSun,
  Code2,
  Copy,
  Database,
  Download,
  Edit3,
  Eye,
  EyeOff,
  File,
  FileCode2,
  Filter,
  Home,
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
  MessageCircle,
  MessageSquare,
  Monitor,
  Network,
  Newspaper,
  Package,
  Pause,
  Pin,
  Play,
  Plus,
  Power,
  Radio,
  RefreshCw,
  Route,
  Ruler,
  Satellite,
  Save,
  Search,
  Server,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Star,
  Sun,
  Terminal,
  Thermometer,
  Timer,
  Trash2,
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
import { useSettingsOptional, type IconStyle } from '../../contexts/SettingsContext';

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
  activity: { lucide: Activity, emoji: '📈', usage: 'packet and activity monitoring' },
  airQuality: { lucide: AirVent, emoji: '💨', usage: 'air-quality telemetry' },
  alarm: { lucide: AlarmClock, emoji: '⏰', usage: 'scheduled and timed actions' },
  alert: { lucide: AlertTriangle, emoji: '⚠️', usage: 'warnings and security risks' },
  archive: { lucide: Archive, emoji: '🗄️', usage: 'archives and retained data' },
  back: { lucide: ArrowLeft, emoji: '⬅️', usage: 'back navigation' },
  battery: { lucide: Battery, emoji: '🔋', usage: 'battery state' },
  batteryCharging: { lucide: BatteryCharging, emoji: '🔌', usage: 'external power and charging' },
  bot: { lucide: Bot, emoji: '🤖', usage: 'automations and auto responders' },
  channels: { lucide: MessageSquare, emoji: '💬', usage: 'channels' },
  check: { lucide: Check, emoji: '✅', usage: 'success and enabled state' },
  checkAll: { lucide: CheckCheck, emoji: '✅', usage: 'delivered and fully acknowledged state' },
  chevronDown: { lucide: ChevronDown, emoji: '▼️', usage: 'expanded menus' },
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
  file: { lucide: File, emoji: '📄', usage: 'files' },
  fileCode: { lucide: FileCode2, emoji: '📄', usage: 'script files' },
  filter: { lucide: Filter, emoji: '🔍', usage: 'filter controls' },
  forward: { lucide: ArrowRight, emoji: '➡️', usage: 'forward navigation' },
  help: { lucide: CircleHelp, emoji: '❓', usage: 'help and unknown state' },
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
  messages: { lucide: MessageCircle, emoji: '💬', usage: 'messages and replies' },
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
  refresh: { lucide: RefreshCw, emoji: '🔄', usage: 'refresh, reload, and reboot' },
  repeater: { lucide: Radio, emoji: '📡', usage: 'MeshCore repeater role' },
  reports: { lucide: ClipboardList, emoji: '📋', usage: 'reports and audit logs' },
  route: { lucide: Route, emoji: '🔀', usage: 'routes and traceroutes' },
  ruler: { lucide: Ruler, emoji: '📏', usage: 'distance' },
  save: { lucide: Save, emoji: '💾', usage: 'save actions' },
  search: { lucide: Search, emoji: '🔍', usage: 'search and scan actions' },
  security: { lucide: Shield, emoji: '🛡️', usage: 'security' },
  securityAlert: { lucide: ShieldAlert, emoji: '⚠️', usage: 'security alerts' },
  securityCheck: { lucide: ShieldCheck, emoji: '🛡️', usage: 'verified security state' },
  sensor: { lucide: Thermometer, emoji: '🌡️', usage: 'MeshCore sensor role' },
  server: { lucide: Server, emoji: '🖥️', usage: 'servers and services' },
  settings: { lucide: Settings, emoji: '⚙️', usage: 'settings' },
  sparkles: { lucide: Sparkles, emoji: '✨', usage: 'new and featured items' },
  sun: { lucide: Sun, emoji: '☀️', usage: 'weather and solar data' },
  telemetry: { lucide: BarChart3, emoji: '📊', usage: 'telemetry and charts' },
  terminal: { lucide: Terminal, emoji: '💻', usage: 'console and shell actions' },
  time: { lucide: Clock, emoji: '🕐', usage: 'time and last-heard state' },
  timer: { lucide: Timer, emoji: '⏱️', usage: 'timeouts and durations' },
  unencrypted: { lucide: Eye, emoji: '🔓', usage: 'unencrypted and visible state' },
  unmute: { lucide: Volume2, emoji: '🔔', usage: 'enabled notification audio' },
  upload: { lucide: Upload, emoji: '📤', usage: 'uploads and imports' },
  user: { lucide: User, emoji: '👤', usage: 'a user or node owner' },
  users: { lucide: Users, emoji: '👥', usage: 'user administration' },
  visibilityOff: { lucide: EyeOff, emoji: '🙈', usage: 'hidden state' },
  weather: { lucide: CloudSun, emoji: '☀️', usage: 'weather data' },
  wifi: { lucide: Wifi, emoji: '📶', usage: 'signal and SNR' },
  wind: { lucide: Wind, emoji: '💨', usage: 'air and wind data' },
  wrench: { lucide: Wrench, emoji: '🛠️', usage: 'administration and tools' },
  zap: { lucide: Zap, emoji: '⚡', usage: 'voltage and admin commands' },
  downloadData: { lucide: ArrowDownToLine, emoji: '📥', usage: 'data export' },
  uploadData: { lucide: ArrowUpFromLine, emoji: '📤', usage: 'data import' },
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
  const settings = useSettingsOptional();
  const resolvedStyle = iconStyle ?? settings?.iconStyle ?? 'lucide';
  const definition = UI_ICON_DEFINITIONS[name];

  if (resolvedStyle === 'emoji') {
    return (
      <span
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
      className={className}
      size={size}
      strokeWidth={strokeWidth}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      style={style}
    />
  );
}
