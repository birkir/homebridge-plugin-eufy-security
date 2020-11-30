import ip from 'ip';
import {ChildProcess, spawn} from 'child_process';
import { FullDevice } from 'eufy-node-client/src/http/http-response.models';
import { createSocket, Socket } from 'dgram';

import {
  CameraController,
  CameraStreamingDelegate,
  HAP,
  StartStreamRequest,
  PrepareStreamCallback,
  PrepareStreamRequest,
  PrepareStreamResponse,
  SnapshotRequest,
  SnapshotRequestCallback,
  SRTPCryptoSuites,
  StreamingRequest,
  StreamRequestCallback,
  StreamRequestTypes,
  StreamSessionIdentifier,
  VideoInfo,
} from 'homebridge';
import { EufySecurityHomebridgePlatform } from './platform';
import { defaultFfmpegPath} from '@homebridge/camera-utils';
import { FfmpegProcess } from './ffmpeg';

type ResolutionInfo = {
  width: number;
  height: number;
  videoFilter: string;
};

type SessionInfo = {
  address: string; // address of the HAP controller
  localAddress: string;
  ipv6: boolean;

  videoPort: number;
  videoReturnPort: number;
  videoCryptoSuite: SRTPCryptoSuites; // should be saved if multiple suites are supported
  videoSRTP: Buffer; // key and salt concatenated
  videoSSRC: number; // rtp synchronisation source

  audioPort: number;
  audioReturnPort: number;
  audioCryptoSuite: SRTPCryptoSuites;
  audioSRTP: Buffer;
  audioSSRC: number;
};


type ActiveSession = {
  mainProcess?: FfmpegProcess;
  returnProcess?: FfmpegProcess;
  timeout?: NodeJS.Timeout;
  socket?: Socket;
};


const FFMPEGH264ProfileNames = [
  'baseline',
  'main',
  'high',
];
const FFMPEGH264LevelNames = [
  '3.1',
  '3.2',
  '4.0',
];

export class EufyCameraStreamingDelegate implements CameraStreamingDelegate {

  private ffmpegDebugOutput = false;

  private readonly platform: EufySecurityHomebridgePlatform;
  private readonly hap: HAP;
  private readonly device: FullDevice;

  private videoProcessor = defaultFfmpegPath;

  controller?: CameraController;

  // keep track of sessions
  pendingSessions: Record<string, SessionInfo> = {};
  ongoingSessions: Record<string, ActiveSession> = {};

  videoConfig = {
    forceMax: undefined,
    maxWidth: 1280,
    maxHeight: 720,
    videoFilter: 'scale=1280:720',
    'maxStreams': 2,
    'maxFPS': 30,
    'maxBitrate': undefined,
    'vcodec': 'libx264',
    'audio': false,
    'packetSize': 188,
    'hflip': undefined,
    'additionalCommandline': undefined,
    debug: true,
  };

  constructor(platform: EufySecurityHomebridgePlatform, device: FullDevice) {
    this.platform = platform;
    this.hap = platform.api.hap;
    this.device = device;

    platform.api.on('shutdown', () => {
      // will kill the live url
      this.platform.httpService.stopStream({
        device_sn: this.device.device_sn,
        station_sn: this.device.station_sn,
        proto: 2,
      }).catch(err => {
        // noop
      });
    });

  }

  private determineResolution(request: SnapshotRequest | VideoInfo, isSnapshot: boolean): ResolutionInfo {
    let width = request.width;
    let height = request.height;
    if (!isSnapshot) {
      if ((this.videoConfig.forceMax && this.videoConfig.maxWidth) ||
        (request.width > this.videoConfig.maxWidth)) {
        width = this.videoConfig.maxWidth;
      }
      if ((this.videoConfig.forceMax && this.videoConfig.maxHeight) ||
        (request.height > this.videoConfig.maxHeight)) {
        height = this.videoConfig.maxHeight;
      }
    }

    const filters: Array<string> = [].concat((this.videoConfig.videoFilter as any) || []);
    const noneFilter = filters.indexOf('none');
    if (noneFilter >= 0) {
      filters.splice(noneFilter, 1);
    }
    if (noneFilter < 0) {
      if (width > 0 || height > 0) {
        // filters.push('scale=' + (width > 0 ? '\'min(' + width + ',iw)\'' : 'iw') + ':' +
        //   (height > 0 ? '\'min(' + height + ',ih)\'' : 'ih') +
        //   ':force_original_aspect_ratio=decrease');
        filters.push('scale=\'trunc(iw/2)*2\':\'trunc(ih/2)*2\''); // Force to fit encoder restrictions
      }
    }

    return {
      width: width,
      height: height,
      videoFilter: filters.join(','),
    };
  }

  handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): void {
    const resolution = this.determineResolution(request, true);

    // get device info
    this.platform.httpService.listDevices({
      device_sn: this.device.device_sn,
    }).then(([device]) => {

      this.platform.log.debug('Snapshot requested: ' + request.width + ' x ' + request.height);
      this.platform.log.debug('Sending snapshot: ' + (resolution.width > 0 ? resolution.width : 'native') + ' x ' +
        (resolution.height > 0 ? resolution.height : 'native'));
      let ffmpegArgs = `-i ${device.cover_path}`;
  
      ffmpegArgs += // Still
        ' -frames:v 1' +
        (resolution.videoFilter ? ' -filter:v ' + resolution.videoFilter : '') +
        ' -f image2 -';
  
      try {
        const ffmpeg = spawn(this.videoProcessor, ffmpegArgs.split(/\s+/), { env: process.env });
  
        let imageBuffer = Buffer.alloc(0);
        this.platform.log.debug('Snapshot command: ' + this.videoProcessor + ' ' + ffmpegArgs);
        ffmpeg.stdout.on('data', (data: Uint8Array) => {
          imageBuffer = Buffer.concat([imageBuffer, data]);
        });
        ffmpeg.on('error', (error: string) => {
          this.platform.log.error('An error occurred while making snapshot request: ' + error);
        });
        ffmpeg.on('close', () => {
          callback(undefined, imageBuffer);
        });
      } catch (err) {
        this.platform.log.error(err);
        callback(err);
      }
    });
  }

  // called when iOS request rtp setup
  prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): void {
    const sessionId: StreamSessionIdentifier = request.sessionID;
    const targetAddress = request.targetAddress;

    const video = request.video;
    const videoPort = video.port;

    const videoCryptoSuite = video.srtpCryptoSuite; // could be used to support multiple crypto suite (or support no suite for debugging)
    const videoSrtpKey = video.srtp_key;
    const videoSrtpSalt = video.srtp_salt;

    const videoSSRC = this.hap.CameraController.generateSynchronisationSource();

    const sessionInfo: Partial<SessionInfo> = {
      address: targetAddress,

      videoPort: videoPort,
      videoCryptoSuite: videoCryptoSuite,
      videoSRTP: Buffer.concat([videoSrtpKey, videoSrtpSalt]),
      videoSSRC: videoSSRC,
    };

    const currentAddress = ip.address('public', request.addressVersion); // ipAddress version must match
    const response: PrepareStreamResponse = {
      address: currentAddress,
      video: {
        port: videoPort,
        ssrc: videoSSRC,

        srtp_key: videoSrtpKey,
        srtp_salt: videoSrtpSalt,
      },
      // audio is omitted as we do not support audio in this example
    };

    this.pendingSessions[sessionId] = sessionInfo as any;
    callback(undefined, response);
  }

  private startStream(request: StartStreamRequest, callback: StreamRequestCallback): void {
    this.platform.httpService.startStream({
      device_sn: this.device.device_sn,
      station_sn: this.device.station_sn,
      proto: 2,
    })
      .then(async ({ url }) => {
      // settle for 1 sec
        await new Promise(r => setTimeout(r, 1000));
        return { url };
      })
      .then(({ url }) => {
        const sessionInfo = this.pendingSessions[request.sessionID];
        const vcodec = this.videoConfig.vcodec || 'libx264';
        const mtu = 1316; // request.video.mtu is not used
        let encoderOptions;
        if (!encoderOptions && vcodec === 'libx264') {
          encoderOptions = '-preset ultrafast -tune zerolatency';
        }

        const resolution = this.determineResolution(request.video, false);
        let fps = request.video.fps;
        let videoBitrate = request.video.max_bit_rate;

        if (vcodec === 'copy') {
          resolution.width = 0;
          resolution.height = 0;
          resolution.videoFilter = '';
          fps = 0;
          videoBitrate = 0;
        }

        this.platform.log.debug('Video stream requested: ' + request.video.width + ' x ' + request.video.height + ', ' +
        request.video.fps + ' fps, ' + request.video.max_bit_rate + ' kbps');
        this.platform.log.info('Starting video stream: ' + (resolution.width > 0 ? resolution.width : 'native') + ' x ' +
        (resolution.height > 0 ? resolution.height : 'native') + ', ' + (fps > 0 ? fps : 'native') +
        ' fps, ' + (videoBitrate > 0 ? videoBitrate : '???') + ' kbps');

        let ffmpegArgs = `-i ${url}`;

        ffmpegArgs += // Video
        // (this.videoConfig.mapvideo ? ' -map ' + this.videoConfig.mapvideo : ' -an -sn -dn') +
        ' -an -sn -dn' +
        ' -codec:v ' + vcodec +
        ' -pix_fmt yuv420p' +
        ' -color_range mpeg' +
        // (fps > 0 ? ' -r ' + fps : '') +
        ' -f rawvideo' +
        (encoderOptions ? ' ' + encoderOptions : '') +
        (resolution.videoFilter.length > 0 ? ' -filter:v ' + resolution.videoFilter : '') +
        // (videoBitrate > 0 ? ' -b:v ' + videoBitrate + 'k' : '') +
        ' -payload_type ' + request.video.pt;

        ffmpegArgs += // Video Stream
        ' -ssrc ' + sessionInfo.videoSSRC +
        ' -f rtp' +
        ' -srtp_out_suite AES_CM_128_HMAC_SHA1_80' +
        ' -srtp_out_params ' + sessionInfo.videoSRTP.toString('base64') +
        ' srtp://' + sessionInfo.address + ':' + sessionInfo.videoPort +
        '?rtcpport=' + sessionInfo.videoPort + '&pkt_size=' + mtu + '';

        if (this.videoConfig.audio) {
          ffmpegArgs += // Audio
          // (this.videoConfig.mapaudio ? ' -map ' + this.videoConfig.mapaudio : ' -vn -sn -dn') +
          ' -vn -sn -dn' +
          ' -codec:a libfdk_aac' +
          ' -profile:a aac_eld' +
          ' -flags +global_header' +
          ' -f null' +
          ' -ar ' + request.audio.sample_rate + 'k' +
          ' -b:a ' + request.audio.max_bit_rate + 'k' +
          ' -ac ' + request.audio.channel +
          ' -payload_type ' + request.audio.pt;

          ffmpegArgs += // Audio Stream
          ' -ssrc ' + sessionInfo.audioSSRC +
          ' -f rtp' +
          ' -srtp_out_suite AES_CM_128_HMAC_SHA1_80' +
          ' -srtp_out_params ' + sessionInfo.audioSRTP.toString('base64') +
          ' srtp://' + sessionInfo.address + ':' + sessionInfo.audioPort +
          '?rtcpport=' + sessionInfo.audioPort + '&pkt_size=188';
        }

        if (this.videoConfig.debug) {
          ffmpegArgs += ' -loglevel level+verbose';
        }

        const activeSession: ActiveSession = {};

        activeSession.socket = createSocket(sessionInfo.ipv6 ? 'udp6' : 'udp4');
        activeSession.socket.on('error', (err: Error) => {
          this.platform.log.error('Socket error: ' + err.name);
        // @todo
        // this.stopStream(request.sessionID);
        });
        activeSession.socket.on('message', () => {
          if (activeSession.timeout) {
            clearTimeout(activeSession.timeout);
          }
          activeSession.timeout = setTimeout(() => {
            this.platform.log.info('Device appears to be inactive. Stopping stream.');
          this.controller!.forceStopStreamingSession(request.sessionID);
          // @todo 
          // this.stopStream(request.sessionID);
          }, request.video.rtcp_interval * 2 * 1000);
        });
        activeSession.socket.bind(sessionInfo.videoReturnPort, sessionInfo.localAddress);

        activeSession.mainProcess = new FfmpegProcess(this.device.device_name, request.sessionID, this.videoProcessor, ffmpegArgs, this.platform.log, this.videoConfig.debug, this, callback);
        // console.log('ffmpeg ' + ffmpegArgs);
        // setTimeout(() => {
        //   callback();
        // }, 5000);

        // if (this.videoConfig.returnAudioTarget) {
        //   let ffmpegReturnArgs =
        //     '-hide_banner' +
        //     ' -protocol_whitelist pipe,udp,rtp,file,crypto' +
        //     ' -f sdp' +
        //     ' -c:a libfdk_aac' +
        //     ' -i pipe:' +
        //     ' ' + this.videoConfig.returnAudioTarget;

        //   if (this.videoConfig.debugReturn) {
        //     ffmpegReturnArgs += ' -loglevel level+verbose';
        //   }

        //   const ipVer = sessionInfo.ipv6 ? 'IP6' : 'IP4';

        //   const sdpReturnAudio =
        //     'v=0\r\n' +
        //     'o=- 0 0 IN ' + ipVer + ' ' + sessionInfo.address + '\r\n' +
        //     's=Talk\r\n' +
        //     'c=IN ' + ipVer + ' ' + sessionInfo.address + '\r\n' +
        //     't=0 0\r\n' +
        //     'm=audio ' + sessionInfo.audioReturnPort + ' RTP/AVP 110\r\n' +
        //     'b=AS:24\r\n' +
        //     'a=rtpmap:110 MPEG4-GENERIC/16000/1\r\n' +
        //     'a=rtcp-mux\r\n' + // FFmpeg ignores this, but might as well
        //     'a=fmtp:110 ' +
        //       'profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3; ' +
        //       'config=F8F0212C00BC00\r\n' +
        //     'a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:' + sessionInfo.audioSRTP.toString('base64') + '\r\n';
        //   activeSession.returnProcess = new FfmpegProcess(this.cameraName + '] [Two-way', request.sessionID,
        //     this.videoProcessor, ffmpegReturnArgs, this.log, this.videoConfig.debugReturn, this);
        //   activeSession.returnProcess.getStdin()?.end(sdpReturnAudio);
        // }

        this.ongoingSessions[request.sessionID] = activeSession as any;
        delete this.pendingSessions[request.sessionID];
      });
  }

  stopStream(sessionId: any, callback?: any) {
    this.platform.httpService.stopStream({
      device_sn: this.device.device_sn,
      station_sn: this.device.station_sn,
      proto: 2,
    }).then(() => {
      const session = this.ongoingSessions[sessionId];
      if (session) {
        if (session.timeout) {
          clearTimeout(session.timeout);
        }
        try {
          session.socket?.close();
        } catch (err) {
          this.platform.log.error('Error occurred closing socket: ' + err);
        }
        try {
          session.mainProcess?.stop();
        } catch (err) {
          this.platform.log.error('Error occurred terminating main FFmpeg process: ' + err);
        }
        try {
          session.returnProcess?.stop();
        } catch (err) {
          this.platform.log.error('Error occurred terminating two-way FFmpeg process: ' + err);
        }
      }
      delete this.ongoingSessions[sessionId];
      this.platform.log.info('Stopped video stream.');
      if (callback) {
        callback();
      }
    });
  }

  // called when iOS device asks stream to start/stop/reconfigure
  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    const sessionId = request.sessionID;

    switch (request.type) {
      case StreamRequestTypes.START:
        this.startStream(request, callback);
        // this.platform.httpService.startStream({
        //   device_sn: this.device.device_sn,
        //   station_sn: this.device.station_sn,
        //   proto: 2,
        // })
        // .then(async ({ url }) => {
        //   // settle for 5 sec
        //   await new Promise(r => setTimeout(r, 5000));
        //   return { url };
        // })
        // .then(({ url }) => {
        //   const sessionInfo = this.pendingSessions[sessionId];

        //   const video: VideoInfo = request.video;
  
        //   const profile = FFMPEGH264ProfileNames[video.profile];
        //   const level = FFMPEGH264LevelNames[video.level];
        //   const width = video.width;
        //   const height = video.height;
        //   const fps = video.fps;
  
        //   const payloadType = video.pt;
        //   const maxBitrate = video.max_bit_rate;
        //   const rtcpInterval = video.rtcp_interval; // usually 0.5
        //   const mtu = video.mtu; // maximum transmission unit

        //   console.log('req', request);
        //   console.log('sessinfo', sessionInfo);
  
        //   const address = sessionInfo.address;
        //   const videoPort = sessionInfo.videoPort;
        //   const ssrc = sessionInfo.videoSSRC;
        //   const cryptoSuite = sessionInfo.videoCryptoSuite;
        //   const videoSRTP = sessionInfo.videoSRTP.toString("base64");
  
        //   console.log('url is', url);
        //   console.log(`Starting video stream (${width}x${height}, ${fps} fps, ${maxBitrate} kbps, ${mtu} mtu)...`);

        //   let videoffmpegCommand = `-i ${url} -map 0:0 ` +
        //     `-c:v libx264 -pix_fmt yuv420p -r ${fps} -an -sn -dn -b:v ${maxBitrate}k -bufsize ${2*maxBitrate}k -maxrate ${maxBitrate}k ` +
        //     `-payload_type ${payloadType} -ssrc ${ssrc} -f rtp `; // -profile:v ${profile} -level:v ${level}
  
        //   if (cryptoSuite === SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80) { // actually ffmpeg just supports AES_CM_128_HMAC_SHA1_80
        //     videoffmpegCommand += `-srtp_out_suite AES_CM_128_HMAC_SHA1_80 -srtp_out_params ${videoSRTP} s`;
        //   }
  
        //   videoffmpegCommand += `rtp://${address}:${videoPort}?rtcpport=${videoPort}&localrtcpport=${videoPort}&pkt_size=${mtu}`;
  
        //   if (this.ffmpegDebugOutput) {
        //     console.log("FFMPEG command: ffmpeg " + videoffmpegCommand);
        //   }

        //   console.log('ffmpeg cmd', videoffmpegCommand);
  
        //   const ffmpegVideo = spawn('ffmpeg', videoffmpegCommand.split(' '), {env: process.env});

        //   let started = false;
        //   ffmpegVideo.stderr.on('data', data => {
        //     console.log("VIDEO: " + String(data));
        //     if (!started) {
        //       started = true;
        //       console.log("FFMPEG: received first frame");

        //       callback(); // do not forget to execute callback once set up
        //     }

        //     if (this.ffmpegDebugOutput) {
        //       console.log("VIDEO: " + String(data));
        //     }
        //   });
        //   ffmpegVideo.on('error', error => {
        //     console.log("[Video] Failed to start video stream: " + error.message);
        //     callback(new Error("ffmpeg process creation failed!"));
        //   });
        //   ffmpegVideo.on('exit', (code, signal) => {
        //     const message = "[Video] ffmpeg exited with code: " + code + " and signal: " + signal;

        //     if (code == null || code === 255) {
        //       console.log(message + " (Video stream stopped!)");
        //     } else {
        //       console.log(message + " (error)");

        //       if (!started) {
        //         callback(new Error(message));
        //       } else {
        //         this.controller!.forceStopStreamingSession(sessionId);
        //       }
        //     }
        //   });

        //   this.ongoingSessions[sessionId] = ffmpegVideo;
        //   delete this.pendingSessions[sessionId];

        // });

        break;
      case StreamRequestTypes.RECONFIGURE:
        // not supported by this example
        console.log('Received (unsupported) request to reconfigure to: ' + JSON.stringify(request.video));
        callback();
        break;
      case StreamRequestTypes.STOP:
        console.log('killing session');
        this.stopStream(request.sessionID, callback);
        break;
    }
  }

}