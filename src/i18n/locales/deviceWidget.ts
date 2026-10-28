const COPY = {
  zh: {
    title: '设备中心', subtitle: 'Lumi 客户端与外部设备观察', online: '在线',
    registered: '已登记', offline: '离线',
    loading: '正在读取设备', unavailable: '暂时无法读取设备状态',
    empty: '连接其他设备，在这里查看状态', manage: '查看与管理设备',
    clientsOnline: '客户端在线', usbPresent: 'USB 设备', lanCandidates: '局域网发现',
    observing: '正在观察外部设备', observationWarning: '部分观察有提示，可进入设备中心查看。',
  },
  en: {
    title: 'Device center', subtitle: 'Lumi clients and external observations', online: 'Online',
    registered: 'Registered', offline: 'Offline',
    loading: 'Loading devices', unavailable: 'Device status is unavailable',
    empty: 'Connect another device to see its status here', manage: 'View and manage devices',
    clientsOnline: 'Clients online', usbPresent: 'USB devices', lanCandidates: 'LAN discovered',
    observing: 'Observing external devices', observationWarning: 'Some observations need attention. Open device center for details.',
  },
};
export const deviceWidgetCopy = (locale: 'zh' | 'en') => COPY[locale];
