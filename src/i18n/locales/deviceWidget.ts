const COPY = {
  zh: {
    title: '设备中心', subtitle: '你的设备，与 Lumi 相连', online: '在线',
    registered: '已登记', offline: '离线', pairing: '配对中',
    loading: '正在读取设备', unavailable: '暂时无法读取设备状态',
    empty: '连接其他设备，在这里查看状态', manage: '查看与管理设备',
  },
  en: {
    title: 'Device center', subtitle: 'Your devices, connected to Lumi', online: 'Online',
    registered: 'Registered', offline: 'Offline', pairing: 'Pairing',
    loading: 'Loading devices', unavailable: 'Device status is unavailable',
    empty: 'Connect another device to see its status here', manage: 'View and manage devices',
  },
};
export const deviceWidgetCopy = (locale: 'zh' | 'en') => COPY[locale];
