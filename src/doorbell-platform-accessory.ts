import { 
  AudioStreamingCodecType,
  AudioStreamingSamplerate,
  Service, PlatformAccessory, CharacteristicValue, CharacteristicSetCallback, CharacteristicGetCallback, CameraControllerOptions } from 'homebridge';
import { FullDevice } from 'eufy-node-client/src/http/http-response.models';
import { EufySecurityHomebridgePlatform } from './platform';
import { EufyCameraStreamingDelegate } from './streaming-delegate';

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
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Eufy')
      .setCharacteristic(this.platform.Characteristic.Model, device.device_model)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, device.device_sn);

    this.platform.log.debug('Device', device);

    this.service = this.accessory.getService(this.platform.Service.Doorbell) || this.accessory.addService(this.platform.Service.Doorbell);

    this.service.setCharacteristic(this.platform.Characteristic.Name, 'Test device');

    this.service.getCharacteristic(this.platform.Characteristic.Mute)
      .on('get', this.handleMuteGet.bind(this))
      .on('set', this.handleMuteSet.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.ProgrammableSwitchEvent)
      .on('get', (callback: CharacteristicGetCallback) => {
        // HomeKit wants this to always be null.
        callback(null, null);
      });
    this.service.setPrimaryService(true);

    // camera
    const { hap } = this.platform.api;
    const streamingDelegate = new EufyCameraStreamingDelegate(this.platform, device);
    const options: CameraControllerOptions = {
      cameraStreamCount: 2, // HomeKit requires at least 2 streams, but 1 is also just fine
      delegate: streamingDelegate,
      streamingOptions: {
        supportedCryptoSuites: [hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          resolutions: [
            [320, 180, 30],
            [320, 240, 15], // Apple Watch requires this configuration
            [320, 240, 30],
            [480, 270, 30],
            [480, 360, 30],
            [640, 360, 30],
            [640, 480, 30],
            [1280, 720, 30],
            [1280, 960, 30],
            [1920, 1080, 30],
            [1600, 1200, 30],
          ],
          codec: {
            profiles: [hap.H264Profile.BASELINE, hap.H264Profile.MAIN, hap.H264Profile.HIGH],
            levels: [hap.H264Level.LEVEL3_1, hap.H264Level.LEVEL3_2, hap.H264Level.LEVEL4_0],
          },
        },
        // audio: {
        //   twoWayAudio: false, // !!this.videoConfig.returnAudioTarget,
        //   codecs: [
        //     {
        //       type: AudioStreamingCodecType.AAC_ELD,
        //       samplerate: AudioStreamingSamplerate.KHZ_16
        //     }
        //   ]
        // }
      },
    };

    const cameraController = new hap.CameraController(options);
    streamingDelegate.controller = cameraController;

    accessory.configureController(cameraController);

    // this.service.updateCharacteristic(this.platform.Characteristic.ProgrammableSwitchEvent, );


    // this.registerObservableCharacteristic({
    //   characteristicType: Characteristic.ProgrammableSwitchEvent,
    //   serviceType: Service.Doorbell,
    //   onValue: onDoorbellPressed.pipe(
    //     switchMap(async (eventDescription) => {
    //       return Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS;
    //     })
    //   ),
    // });



    // // get the LightBulb service if it exists, otherwise create a new LightBulb service
    // // you can create multiple services for each accessory
    // this.service = this.accessory.getService(this.platform.Service.Lightbulb) || this.accessory.addService(this.platform.Service.Lightbulb);

    // // set the service name, this is what is displayed as the default name on the Home app
    // // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    // this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.exampleDisplayName);

    // // each service must implement at-minimum the "required characteristics" for the given service type
    // // see https://developers.homebridge.io/#/service/Lightbulb

    // // register handlers for the On/Off Characteristic
    // this.service.getCharacteristic(this.platform.Characteristic.On)
    //   .on('set', this.setOn.bind(this))                // SET - bind to the `setOn` method below
    //   .on('get', this.getOn.bind(this));               // GET - bind to the `getOn` method below

    // // register handlers for the Brightness Characteristic
    // // this.service.getCharacteristic(this.platform.Characteristic.Brightness)
    // //   .on('set', this.setBrightness.bind(this));       // SET - bind to the 'setBrightness` method below


    // /**
    //  * Creating multiple services of the same type.
    //  * 
    //  * To avoid "Cannot add a Service with the same UUID another Service without also defining a unique 'subtype' property." error,
    //  * when creating multiple services of the same type, you need to use the following syntax to specify a name and subtype id:
    //  * this.accessory.getService('NAME') || this.accessory.addService(this.platform.Service.Lightbulb, 'NAME', 'USER_DEFINED_SUBTYPE_ID');
    //  * 
    //  * The USER_DEFINED_SUBTYPE must be unique to the platform accessory (if you platform exposes multiple accessories, each accessory
    //  * can use the same sub type id.)
    //  */



    

    // // Example: add two "motion sensor" services to the accessory
    // const motionSensorOneService = this.accessory.getService('Motion Sensor One Name') ||
    //   this.accessory.addService(this.platform.Service.MotionSensor, 'Motion Sensor One Name', 'YourUniqueIdentifier-1');

    // const motionSensorTwoService = this.accessory.getService('Motion Sensor Two Name') ||
    //   this.accessory.addService(this.platform.Service.MotionSensor, 'Motion Sensor Two Name', 'YourUniqueIdentifier-2');

    // /**
    //  * Updating characteristics values asynchronously.
    //  * 
    //  * Example showing how to update the state of a Characteristic asynchronously instead
    //  * of using the `on('get')` handlers.
    //  * Here we change update the motion sensor trigger states on and off every 10 seconds
    //  * the `updateCharacteristic` method.
    //  * 
    //  */
    // let motionDetected = false;
    // setInterval(() => {
    //   // EXAMPLE - inverse the trigger
    //   motionDetected = !motionDetected;

    //   // push the new value to HomeKit
    //   motionSensorOneService.updateCharacteristic(this.platform.Characteristic.MotionDetected, motionDetected);
    //   motionSensorTwoService.updateCharacteristic(this.platform.Characteristic.MotionDetected, !motionDetected);

    //   this.platform.log.debug('Triggering motionSensorOneService:', motionDetected);
    //   this.platform.log.debug('Triggering motionSensorTwoService:', !motionDetected);
    // }, 10000);
  }


  onMessage(message: any) {
    console.log('foobarb');
  }

  handleProgrammableSwitchEventGet(callback: CharacteristicGetCallback) {
    callback(null, null);
  }

  handleMuteGet(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    // set volume to `value`
    callback(null);
  }

  handleMuteSet(callback: CharacteristicGetCallback) {
    const currentVolume = 1;
    callback(null, currentVolume);
  }


}