import {
  Service,
  PlatformAccessory,
  CharacteristicGetCallback,
} from 'homebridge';
import { FullDevice } from 'eufy-node-client/src/http/http-response.models';
import { EufySecurityHomebridgePlatform } from './platform';
import { EufyCameraStreamingDelegate } from './new-streaming-delegate';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class DoorbellPlatformAccessory {
  private service: Service;

  constructor(
    private readonly platform: EufySecurityHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly device: FullDevice,
  ) {
    this.platform.log.debug('Constructed Doorbell');

    // set accessory information
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Eufy')
      .setCharacteristic(
        this.platform.Characteristic.Model,
        device.device_model,
      )
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        device.device_sn,
      );

    this.platform.log.debug('Device', device);

    this.service =
      this.accessory.getService(this.platform.Service.Doorbell) ||
      this.accessory.addService(this.platform.Service.Doorbell);

    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      'Test device',
    );

    this.service
      .getCharacteristic(this.platform.Characteristic.ProgrammableSwitchEvent)
      .on('get', this.handleProgrammableSwitchEventGet.bind(this));

    this.service.setPrimaryService(true);

    // camera
    const delegate = new EufyCameraStreamingDelegate(this.platform, device);
    accessory.configureController(delegate.controller);
    
    // @todo Mute Mic, Mute Speaker, Volume, BatteryLevel, StatusLowBattery
  }

  handleProgrammableSwitchEventGet(callback: CharacteristicGetCallback) {
    callback(null, null);
  }
}
