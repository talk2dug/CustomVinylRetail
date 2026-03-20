#!/usr/bin/env python3
"""
Fetch the current RTSP streaming URI from a LaView ONVIF camera.
The token in the URL rotates on camera reboot, so this must be called
each time before starting/reconnecting ffmpeg.

Usage:
    python get_rtsp_url.py --host 192.168.0.145 --port 8000 \
        --user admin --pass 0000011111 --profile PROFILE_16415

Prints the RTSP URL to stdout. Exits 0 on success, 1 on error (error on stderr).

Requires: pip install onvif-zeep-async
"""

import argparse
import asyncio
import os
import sys
from onvif import ONVIFCamera

# The default wsdl_dir in onvif-zeep-async is often wrong.
# Point it to the actual WSDL files inside the onvif package.
WSDL_DIR = os.path.join(os.path.dirname(os.path.dirname(ONVIFCamera.__module__.replace('.', os.sep))),
                         'onvif', 'wsdl')
# More reliable: find it relative to the onvif package itself
import onvif as _onvif_pkg
WSDL_DIR = os.path.join(os.path.dirname(_onvif_pkg.__file__), 'wsdl')


async def get_rtsp_url(host, port, user, password, profile_token):
    """Connect to camera via ONVIF and fetch the RTSP stream URI."""
    cam = ONVIFCamera(host, int(port), user, password, wsdl_dir=WSDL_DIR)
    await cam.update_xaddrs()

    media_service = await cam.create_media_service()

    # Build the StreamSetup request
    stream_setup = media_service.create_type('GetStreamUri')
    stream_setup.StreamSetup = {
        'Stream': 'RTP-Unicast',
        'Transport': {'Protocol': 'RTSP'}
    }
    stream_setup.ProfileToken = profile_token

    resp = await media_service.GetStreamUri(stream_setup)
    uri = resp.Uri

    # Inject credentials into the URL if not already present
    if '@' not in uri:
        uri = uri.replace('rtsp://', f'rtsp://{user}:{password}@')

    return uri


async def main_async(args):
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
    args = parser.parse_args()

    # Suppress asyncio unclosed session warnings (cosmetic only)
    import logging
    logging.getLogger('asyncio').setLevel(logging.CRITICAL)

    try:
        asyncio.run(main_async(args))
    except Exception as e:
        print(f'ERROR: {e}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
