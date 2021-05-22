import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';
import { HttpService, PushRegisterService, PushClient } from 'eufy-node-client';
import { CheckinResponse, FidInstallationResponse, GcmRegisterResponse } from 'eufy-node-client/src/push/fid.model';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { DoorbellPlatformAccessory } from './doorbell-platform-accessory';
import { DeviceType, MessageTypes } from './eufy-types';
import fs from 'fs';

interface EufyPlatformConfig extends PlatformConfig {
  username: string;
  password: string;
  enablePush: boolean;

  ignoreHubSns: string[];
  ignoreDeviceSns: string[];
  platform: string;
}

interface PushCredentials {
  fidResponse: FidInstallationResponse;
  checkinResponse: CheckinResponse;
  gcmResponse: GcmRegisterResponse;
}

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class EufySecurityHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap
    .Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  public httpService: HttpService;

  private config: EufyPlatformConfig;

  constructor(
    public readonly log: Logger,
    config: PlatformConfig,
    public readonly api: API,
  ) {
    this.config = config as EufyPlatformConfig;
    // this.log.debug('Config', this.config);
    this.log.debug('Finished initializing platform:', this.config.platform);

    this.httpService = new HttpService(this.config.username, this.config.password);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', async () => {
      if (this.config.enablePush) {
        this.log.info('push client enabled');
        await this.setupPushClient();
      } else {
        this.log.info('push client disabled');
      }

      log.debug('Executed didFinishLaunching callback');
      // run the method to discover / register your devices as accessories

      try {
        this.discoverDevices();
      } catch(error) {
        this.log.error('error while discovering devices');
        this.log.error(error);
      }
    });
  }

  async setupPushClient() {
    const storagePath = this.api.user.storagePath();
    const credentialsPath = `${storagePath}/eufy-security-credentials.json`;

    let credentials: PushCredentials;
    if (fs.existsSync(credentialsPath)) {
      this.log.info('credentials found. reusing them...');
      credentials = JSON.parse(fs.readFileSync(credentialsPath).toString());
    } else {
      // Register push credentials
      this.log.info('no credentials found. register new...');
      const pushService = new PushRegisterService();
      credentials = await pushService.createPushCredentials();
      fs.writeFileSync(credentialsPath, JSON.stringify(credentials));
      this.log.info('wait a short time (5sec)...');
      await new Promise((r) => setTimeout(r, 5000));
    }

    // Start push client
    const pushClient = await PushClient.init({
      androidId: credentials.checkinResponse.androidId,
      securityToken: credentials.checkinResponse.securityToken,
    });

    const fcmToken = credentials.gcmResponse.token;
    await new Promise((resolve) => {
      const tHandle = setTimeout(() => {
        this.log.error('registering a push token timed out');
        resolve(true);
      }, 20000);

      this.httpService
        .registerPushToken(fcmToken)
        .catch((err) => {
          clearTimeout(tHandle);
          this.log.error('failed to register push token', err);
          resolve(true);
        })
        .then(() => {
          clearTimeout(tHandle);
          this.log.debug('registered at eufy with:', fcmToken);
          resolve(true);
        });
      
    });

    setInterval(async () => {
      try {
        await this.httpService.pushTokenCheck();
      } catch (err) {
        this.log.warn('failed to confirm push token');
      }
    }, 30 * 1000);

    pushClient.connect((msg) => {
      this.log.debug('push message:', msg);
      const matchingUuid = this.api.hap.uuid.generate(msg.payload?.device_sn);
      const knownAccessory = this.accessories.find(
        (accessory) => accessory.UUID === matchingUuid,
      );
      const event_type = msg.payload?.payload?.event_type;

      if (knownAccessory) {
        if (event_type === MessageTypes.MOTION_DETECTION || event_type === MessageTypes.FACE_DETECTION) {
          // TODO: Implement motion sensor
        } else if (event_type === MessageTypes.PRESS_DOORBELL) {
          knownAccessory
            .getService(this.api.hap.Service.Doorbell)!
            .updateCharacteristic(
              this.api.hap.Characteristic.ProgrammableSwitchEvent,
              this.api.hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
            );
        }
      }
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  /**
   * This is an example method showing how to register discovered accessories.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  async discoverDevices() {
    const hubs = await this.httpService.listHubs();

    for (const hub of hubs) {
      this.log.debug(
        `found hub "${hub.station_name}" (${hub.station_sn}) `,
      );

      if (this.config.ignoreHubSns?.includes(hub.station_sn)) {
        this.log.debug('ignoring hub ' + hub.station_sn);
      }
    }

    const devices = await this.httpService.listDevices();

    for (const device of devices) {
      const ignoredHub = this.config.ignoreHubSns?.includes(device.station_sn);
      const ignoredDevice = this.config.ignoreDeviceSns?.includes(device.device_sn);

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { params, member, station_conn, ...strippedDevice } = device;

      this.log.debug(`found device "${device.device_name}" (${device.device_sn})
ID: ${device.device_id}
Model: ${device.device_model}
Serial Number: ${device.device_sn}
Type: ${device.device_type}
Channel: ${device.device_channel}
Hub: ${device.station_conn.station_name} (${device.station_sn})
      `);
      this.log.debug(
        `device dump: ${{
          ...strippedDevice,
          params: params.map((param) => [
            param.param_id,
            param.param_type,
            param.param_value,
          ]),
        }}`,
      );

      if (ignoredHub) {
        this.log.debug(`device is part of ignored hub "${device.station_sn}"`);
      }

      if (ignoredDevice) {
        this.log.debug(`device is ignored "${device.device_sn}"`);
      }

      if (ignoredHub || ignoredDevice) {
        continue;
      }

      const uuid = this.api.hap.uuid.generate(device.device_sn);
      const existingAccessory = this.accessories.find(
        (accessory) => accessory.UUID === uuid,
      );

      // doorbell
      if (
        [
          DeviceType.BATTERY_DOORBELL,
          DeviceType.BATTERY_DOORBELL_2,
          DeviceType.DOORBELL,
        ].includes(device.device_type)
      ) {
        if (existingAccessory) {
          // the accessory already exists
          this.log.info(
            'Restoring existing accessory from cache:',
            existingAccessory.displayName,
          );
          new DoorbellPlatformAccessory(this, existingAccessory, device);
        } else {
          // the accessory does not yet exist, so we need to create it
          this.log.info('Adding new accessory:', device.device_name);

          // create a new accessory
          const accessory = new this.api.platformAccessory(
            device.device_name,
            uuid,
          );

          // store a copy of the device object in the `accessory.context`
          // the `context` property can be used to store any data about the accessory you may need
          accessory.context.device = device;

          // create the accessory handler for the newly create accessory
          // this is imported from `platformAccessory.ts`
          new DoorbellPlatformAccessory(this, accessory, device);

          // link the accessory to your platform
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
            accessory,
          ]);
        }
      }
    }

    // @todo
    // this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
    // this.log.info('Removing existing accessory from cache:', existingAccessory.displayName);
  }
}
