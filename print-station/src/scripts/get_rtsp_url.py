#!/usr/bin/env python3
"""
Fetch RTSP streaming URIs and discover camera profiles via ONVIF.

Usage:
    # Get RTSP URL for a specific profile
    python get_rtsp_url.py --host 192.168.0.145 --port 8000 \
        --user admin --pass 0000011111 --profile PROFILE_16415

    # Discover all profiles (returns JSON)
    python get_rtsp_url.py --host 192.168.0.145 --port 8000 \
        --user admin --pass 0000011111 --discover

Prints the RTSP URL (or JSON for --discover) to stdout.
Exits 0 on success, 1 on error (error on stderr).

Requires: pip install onvif-zeep-async
"""

import argparse
import asyncio
import json
import os
import sys
from onvif import ONVIFCamera

# Find WSDL files relative to the onvif package
import onvif as _onvif_pkg
WSDL_DIR = os.path.join(os.path.dirname(_onvif_pkg.__file__), 'wsdl')


async def get_rtsp_url(host, port, user, password, profile_token):
    """Connect to camera via ONVIF and fetch the RTSP stream URI."""
    cam = ONVIFCamera(host, int(port), user, password, wsdl_dir=WSDL_DIR)
    await cam.update_xaddrs()

    media_service = await cam.create_media_service()

    stream_setup = media_service.create_type('GetStreamUri')
    stream_setup.StreamSetup = {
        'Stream': 'RTP-Unicast',
        'Transport': {'Protocol': 'RTSP'}
    }
    stream_setup.ProfileToken = profile_token

    resp = await media_service.GetStreamUri(stream_setup)
    uri = resp.Uri

    if '@' not in uri:
        uri = uri.replace('rtsp://', f'rtsp://{user}:{password}@')

    return uri


async def discover_camera(host, port, user, password):
    """Discover all profiles and capabilities from an ONVIF camera. Returns JSON."""
    cam = ONVIFCamera(host, int(port), user, password, wsdl_dir=WSDL_DIR)
    await cam.update_xaddrs()

    media_service = await cam.create_media_service()

    # Get device info
    device_info = {}
    try:
        dev_service = await cam.create_devicemgmt_service()
        info = await dev_service.GetDeviceInformation()
        device_info = {
            'manufacturer': str(getattr(info, 'Manufacturer', '')),
            'model': str(getattr(info, 'Model', '')),
            'firmwareVersion': str(getattr(info, 'FirmwareVersion', '')),
            'serialNumber': str(getattr(info, 'SerialNumber', '')),
            'hardwareId': str(getattr(info, 'HardwareId', ''))
        }
    except Exception as e:
        device_info = {'error': str(e)}

    # Get all media profiles
    profiles_raw = await media_service.GetProfiles()
    profiles = []

    for p in profiles_raw:
        profile = {
            'token': str(p.token),
            'name': str(p.Name),
            'fixed': bool(getattr(p, 'fixed', False))
        }

        # Video encoder config
        vec = getattr(p, 'VideoEncoderConfiguration', None)
        if vec:
            res = getattr(vec, 'Resolution', None)
            rate = getattr(vec, 'RateControl', None)
            profile['video'] = {
                'encoding': str(getattr(vec, 'Encoding', '')),
                'width': int(res.Width) if res else 0,
                'height': int(res.Height) if res else 0,
                'fps': int(rate.FrameRateLimit) if rate else 0,
                'bitrate': int(rate.BitrateLimit) if rate else 0,
                'quality': float(getattr(vec, 'Quality', 0))
            }

        # Video source config
        vsc = getattr(p, 'VideoSourceConfiguration', None)
        if vsc:
            bounds = getattr(vsc, 'Bounds', None)
            profile['source'] = {
                'name': str(getattr(vsc, 'Name', '')),
                'sourceToken': str(getattr(vsc, 'SourceToken', '')),
            }
            if bounds:
                profile['source']['bounds'] = {
                    'width': int(bounds.width),
                    'height': int(bounds.height)
                }

        # Audio encoder config
        aec = getattr(p, 'AudioEncoderConfiguration', None)
        if aec:
            profile['audio'] = {
                'encoding': str(getattr(aec, 'Encoding', '')),
                'bitrate': int(getattr(aec, 'Bitrate', 0)),
                'sampleRate': int(getattr(aec, 'SampleRate', 0))
            }

        # Get RTSP URL for this profile
        try:
            stream_setup = media_service.create_type('GetStreamUri')
            stream_setup.StreamSetup = {
                'Stream': 'RTP-Unicast',
                'Transport': {'Protocol': 'RTSP'}
            }
            stream_setup.ProfileToken = p.token
            resp = await media_service.GetStreamUri(stream_setup)
            uri = resp.Uri
            if '@' not in uri:
                uri = uri.replace('rtsp://', f'rtsp://{user}:{password}@')
            profile['rtspUrl'] = uri
        except Exception as e:
            profile['rtspUrl'] = None
            profile['rtspError'] = str(e)

        profiles.append(profile)

    result = {
        'success': True,
        'host': host,
        'port': int(port),
        'device': device_info,
        'profiles': profiles
    }

    print(json.dumps(result))


async def main_async(args):
    if args.discover:
        await discover_camera(args.host, args.port, args.user, args.password)
    else:
        url = await get_rtsp_url(args.host, args.port, args.user, args.password, args.profile)
        print(url)


def main():
    parser = argparse.ArgumentParser(description='Fetch RTSP URL via ONVIF')
    parser.add_argument('--host', required=True, help='Camera IP address')
    parser.add_argument('--port', default='8000', help='ONVIF port (default 8000)')
    parser.add_argument('--user', default='admin', help='Username')
    parser.add_argument('--pass', dest='password', default='', help='Password')
    parser.add_argument('--profile', default='PROFILE_16415',
                        help='ONVIF profile token (main=PROFILE_16415, sub=PROFILE_16417)')
    parser.add_argument('--discover', action='store_true',
                        help='Discover all profiles and device info (returns JSON)')
    args = parser.parse_args()

    import logging
    logging.getLogger('asyncio').setLevel(logging.CRITICAL)

    try:
        asyncio.run(main_async(args))
    except Exception as e:
        if args.discover:
            print(json.dumps({'success': False, 'error': str(e)}))
        else:
            print(f'ERROR: {e}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
