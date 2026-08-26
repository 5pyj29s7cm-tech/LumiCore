import { describe, expect, it } from 'vitest';
import {
  deriveComputerCapabilityProfile,
  normalizeWindowsPeripheralProbe,
} from '../server/autonomy/system_explorer';

describe('system explorer capability profile', () => {
  it('normalizes useful Windows peripheral facts without persisting unique device identifiers', () => {
    const profile = normalizeWindowsPeripheralProbe({
      displays: [{
        Name: 'NVIDIA RTX Test',
        AdapterRAM: 8 * 1024 ** 3,
        CurrentHorizontalResolution: 2560,
        CurrentVerticalResolution: 1440,
        CurrentRefreshRate: 144,
        PNPDeviceID: 'PCI\\SECRET-DEVICE-ID',
      }],
      audio: [{ Name: 'USB Microphone', DeviceID: 'SECRET-AUDIO-ID' }],
      cameras: [{ FriendlyName: 'Integrated Camera', InstanceId: 'SECRET-CAMERA-ID' }],
      printers: [{ Name: 'Office Printer', PortName: '10.0.0.9' }],
      usb: [{ FriendlyName: 'Drawing Tablet', InstanceId: 'SECRET-USB-ID' }],
      battery: [{ EstimatedChargeRemaining: 87, BatteryStatus: 2 }],
      computer: { Manufacturer: 'Lumi Hardware', Model: 'Workstation', PCSystemType: 1, SerialNumber: 'SECRET-SERIAL' },
    });

    expect(profile).toMatchObject({
      displays: [{ name: 'NVIDIA RTX Test', width: 2560, height: 1440, refreshHz: 144, adapterMemoryGB: 8 }],
      audioDevices: ['USB Microphone'],
      cameras: ['Integrated Camera'],
      printers: ['Office Printer'],
      usbDevices: ['Drawing Tablet'],
      battery: { present: true, chargePercent: 87, status: '2' },
      computer: { manufacturer: 'Lumi Hardware', model: 'Workstation', chassis: '1' },
    });
    const serialized = JSON.stringify(profile);
    expect(serialized).not.toContain('SECRET-');
    expect(serialized).not.toContain('10.0.0.9');
  });

  it('turns verified machine evidence into practical first questions without inferring unsupported capabilities', () => {
    const timestamp = '2026-08-26T00:00:00.000Z';
    const profile = deriveComputerCapabilityProfile({
      timestamp,
      hardware: {
        platform: 'win32',
        arch: 'x64',
        hostname: 'test-host',
        cpus: { model: 'Test CPU', cores: 8, threads: 16 },
        totalMemoryGB: 32,
        gpus: ['NVIDIA RTX Test'],
        disks: [{ name: 'C', totalGB: 1000, freeGB: 500, fsType: 'NTFS' }],
      },
      software: {
        osVersion: 'Windows Test',
        installedApps: ['Microsoft 365', 'Visual Studio Code', 'WeChat', 'Adobe Photoshop', 'Ollama'],
        startupPrograms: [],
        runningServices: [],
      },
      peripherals: {
        displays: [{ name: 'NVIDIA RTX Test', width: 2560, height: 1440 }],
        audioDevices: ['USB Microphone'],
        cameras: ['Integrated Camera'],
        printers: [],
        usbDevices: [],
      },
      runtimes: {
        git: 'git version 2.50.0',
        node: 'v24.0.0',
        python: 'Python 3.13.0',
        wslDistributions: ['Ubuntu'],
        localAiRuntimes: ['Ollama'],
      },
    });

    expect(profile.generatedAt).toBe(timestamp);
    expect(profile.firstQuestions[0].zh).toContain('已经验证');
    expect(profile.opportunities.find(item => item.id === 'software_development')).toMatchObject({
      ready: true,
      evidence: expect.arrayContaining(['Visual Studio Code', 'git version 2.50.0', 'WSL Ubuntu']),
    });
    expect(profile.opportunities.find(item => item.id === 'local_ai')).toMatchObject({
      ready: true,
      evidence: expect.arrayContaining(['Ollama', 'NVIDIA RTX Test']),
    });
    expect(profile.opportunities.find(item => item.id === 'finance_and_operations')?.confidence).toBeLessThan(0.9);
    expect(JSON.stringify(profile)).not.toContain('test-host');
  });
});
