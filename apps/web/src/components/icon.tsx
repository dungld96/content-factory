import {
  Activity,
  AlertTriangle,
  ArrowUpFromLine,
  Check,
  Clapperboard,
  Clock,
  Film,
  FolderKanban,
  Image as ImageIcon,
  Images,
  LayoutDashboard,
  ListChecks,
  Wallet,
  Languages,
  LayoutList,
  Columns3,
  Layers,
  Menu,
  Music,
  PencilLine,
  Play,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Square,
  Undo2,
  Workflow,
  X,
  XCircle,
  type LucideIcon,
} from 'lucide-react';

/**
 * The studio's one icon set (UX review U3, U7): Lucide SVG icons instead of Unicode glyphs, which
 * render differently per OS and font. Icons are decorative (`aria-hidden`); the text next to them
 * carries the meaning.
 */
const ICONS = {
  overview: LayoutDashboard,
  todoList: ListChecks,
  costs: Wallet,
  language: Languages,
  list: LayoutList,
  board: Columns3,
  projects: FolderKanban,
  content: Clapperboard,
  masters: Layers,
  pipeline: Workflow,
  assets: Images,
  operations: Activity,
  settings: Settings,
  search: Search,
  check: Check,
  reject: Undo2,
  edit: PencilLine,
  generate: Sparkles,
  play: Play,
  render: Film,
  music: Music,
  history: Clock,
  upload: ArrowUpFromLine,
  resume: RefreshCw,
  cancel: X,
  warning: AlertTriangle,
  failed: XCircle,
  todo: Square,
  image: ImageIcon,
  menu: Menu,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export function Icon(props: {
  readonly name: IconName;
  readonly size?: number;
  readonly className?: string;
}) {
  const Component = ICONS[props.name];
  return (
    <Component
      aria-hidden="true"
      focusable="false"
      size={props.size ?? 16}
      strokeWidth={1.75}
      className={props.className ? `icon ${props.className}` : 'icon'}
    />
  );
}
