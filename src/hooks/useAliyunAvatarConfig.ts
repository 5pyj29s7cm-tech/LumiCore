import { useEffect, useState } from 'react';
import { aliyunAvatarService } from '../services/aliyunAvatarService';
import type { AliyunAvatarConfig } from '../../shared/aliyun_avatar';
/** Keyed by person and owner; refreshing settings cannot expose another person's binding. */
export function useAliyunAvatarConfig(ownerId: string, avatarId: string, refresh?: unknown) {
  const key = JSON.stringify([ownerId, avatarId]);
  const [state, setState] = useState<{ key: string; config: AliyunAvatarConfig } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void aliyunAvatarService.config(avatarId, controller.signal).then(config => { if (!controller.signal.aborted) setState({ key, config }); }).catch(() => {});
    return () => controller.abort();
  }, [key, avatarId, refresh]);
  return state?.key === key ? state.config : null;
}
