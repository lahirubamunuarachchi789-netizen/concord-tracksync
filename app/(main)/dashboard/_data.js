/**
 * Static demo content for the Dashboard section.
 * Swap for live Supabase queries as each module comes online.
 */
import { AlertIcon, BoltIcon, LayersIcon, TrendingUpIcon } from '@/components/icons';

export const KPI = [
  {
    label: 'Active Lines',
    value: '12',
    delta: '+2 today',
    tone: 'up',
    Icon: LayersIcon,
    gradient: 'from-blue-600 to-indigo-600',
  },
  {
    label: 'Units Produced',
    value: '8,452',
    delta: '+6.4% vs yesterday',
    tone: 'up',
    Icon: TrendingUpIcon,
    gradient: 'from-indigo-600 to-purple-600',
  },
  {
    label: 'Line Efficiency',
    value: '91.2%',
    delta: '-1.1% vs target',
    tone: 'down',
    Icon: BoltIcon,
    gradient: 'from-sky-500 to-blue-600',
  },
  {
    label: 'Open Alerts',
    value: '3',
    delta: '2 quality · 1 maintenance',
    tone: 'flat',
    Icon: AlertIcon,
    gradient: 'from-purple-600 to-fuchsia-600',
  },
];

export const OUTPUT_WEEK = [
  { day: 'Mon', units: 64 },
  { day: 'Tue', units: 78 },
  { day: 'Wed', units: 52 },
  { day: 'Thu', units: 90 },
  { day: 'Fri', units: 71 },
  { day: 'Sat', units: 85 },
  { day: 'Sun', units: 96 },
];

export const MAX_UNITS = Math.max(...OUTPUT_WEEK.map((entry) => entry.units));

export const DEPARTMENT_PROGRESS = [
  { name: 'Desma', progress: 92 },
  { name: 'Cutting', progress: 78 },
  { name: 'Stitching', progress: 64 },
  { name: 'Assembly', progress: 71 },
  { name: 'Quality Control', progress: 88 },
];

export const RECENT_ACTIVITY = [
  {
    time: '08:42',
    line: 'Line 04',
    event: 'Batch #CTS-2418 completed',
    department: 'Desma',
    status: 'Completed',
  },
  {
    time: '09:15',
    line: 'Line 07',
    event: 'Material request raised',
    department: 'Stitching',
    status: 'Pending',
  },
  {
    time: '10:03',
    line: 'Line 02',
    event: 'Quality check failed - rework',
    department: 'Quality Control',
    status: 'Attention',
  },
  {
    time: '11:27',
    line: 'Line 09',
    event: 'Shift handover logged',
    department: 'Assembly',
    status: 'Completed',
  },
];

export const STATUS_STYLES = {
  Completed: 'bg-emerald-50 text-emerald-600 ring-emerald-100',
  Pending: 'bg-amber-50 text-amber-600 ring-amber-100',
  Attention: 'bg-red-50 text-red-600 ring-red-100',
};