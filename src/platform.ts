import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from "homebridge";
import { HttpService, PushRegisterService, PushClient } from "eufy-node-client";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings";
import { DoorbellPlatformAccessory } from "./doorbell-platform-accessory";
import { DeviceType } from "./eufy-types";
import fs from "fs";

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

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API
  ) {
    this.log.debug("Config", this.config);
    this.log.debug("Finished initializing platform:", this.config.name);

    this.httpService = new HttpService(
      (config as any).username,
      (config as any).password
    );

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on("didFinishLaunching", async () => {
      await this.setupPushClient();

      log.debug("Executed didFinishLaunching callback");
      // run the method to discover / register your devices as accessories
      this.discoverDevices();
    });
  }

  async setupPushClient() {
    const storagePath = this.api.user.storagePath();
    const credentialsPath = `${storagePath}/eufy-security-credentials.json`;

    let credentials: any = null;
    if (fs.existsSync(credentialsPath)) {
      this.log.info("credentials found. reusing them...");
      credentials = JSON.parse(fs.readFileSync(credentialsPath).toString());
    } else {
      // Register push credentials
      this.log.info("no credentials found. register new...");
      const pushService = new PushRegisterService();
      credentials = await pushService.createPushCredentials();
      fs.writeFileSync(credentialsPath, JSON.stringify(credentials));
      this.log.info("wait a short time (5sec)...");
      await new Promise((r) => setTimeout(r, 5000));
    }

    // Start push client
    const pushClient = await PushClient.init({
      androidId: credentials.checkinResponse.androidId,
      securityToken: credentials.checkinResponse.securityToken,
    });

    const fcmToken = credentials.gcmResponse.token;
    await this.httpService.registerPushToken(fcmToken);
    this.log.debug("Registered at eufy with:", fcmToken);

    setInterval(async () => {
      await this.httpService.pushTokenCheck();
    }, 30 * 1000);

    pushClient.connect((msg) => {
      this.log.debug("Got push message:", msg);
      const matchingUuid = this.api.hap.uuid.generate(msg.payload.device_sn);
      const knownAccessory = this.accessories.find(
        (accessory) => accessory.UUID === matchingUuid
      );

      if (knownAccessory) {
        knownAccessory
          .getService(this.api.hap.Service.Doorbell)!
          .updateCharacteristic(
            this.api.hap.Characteristic.ProgrammableSwitchEvent,
            this.api.hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS
          );
      }
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info("Loading accessory from cache:", accessory.displayName);

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
      if ((this.config as any).ignoreHubSns?.includes(hub.station_sn)) {
        continue;
      }

      const { station_sn } = hub;

      const devices = await this.httpService.listDevices({ station_sn });

      for (const device of devices) {
        if ((this.config as any).ignoreDeviceIds?.includes(device.device_sn)) {
          continue;
        }

        const uuid = this.api.hap.uuid.generate(device.device_sn);
        const existingAccessory = this.accessories.find(
          (accessory) => accessory.UUID === uuid
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
              "Restoring existing accessory from cache:",
              existingAccessory.displayName
            );
            new DoorbellPlatformAccessory(this, existingAccessory, device);
          } else {
            // the accessory does not yet exist, so we need to create it
            this.log.info("Adding new accessory:", device.device_name);

            // create a new accessory
            const accessory = new this.api.platformAccessory(
              device.device_name,
              uuid
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
    }

    // @todo
    // this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
    // this.log.info('Removing existing accessory from cache:', existingAccessory.displayName);
  }
}
