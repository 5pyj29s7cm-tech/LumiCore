const COPY = {
  zh: {
    title: '设备中心', subtitle: 'Lumi 客户端与外部设备观察', online: '在线',
    registered: '已登记', offline: '离线',
    loading: '正在读取设备', unavailable: '暂时无法读取设备状态',
    empty: '连接其他设备，在这里查看状态', manage: '查看与管理设备',
    clientsOnline: '客户端在线', usbPresent: 'USB / 串口在位', lanCandidates: 'LAN 候选', printQueues: '打印队列',
    observed: '外部观察时间', observing: '正在观察外部设备', externalHint: '发现不代表已连接或可控制；进入设备中心刷新与读取状态。',
  },
  en: {
    title: 'Device center', subtitle: 'Lumi clients and external observations', online: 'Online',
    registered: 'Registered', offline: 'Offline',
    loading: 'Loading devices', unavailable: 'Device status is unavailable',
    empty: 'Connect another device to see its status here', manage: 'View and manage devices',
    clientsOnline: 'Clients online', usbPresent: 'USB / serial present', lanCandidates: 'LAN candidates', printQueues: 'Print queues',
    observed: 'External observation', observing: 'Observing external devices', externalHint: 'Discovery does not enable control. Open the device center to refresh or read status.',
  },
};
export const deviceWidgetCopy = (locale: 'zh' | 'en') => COPY[locale];
