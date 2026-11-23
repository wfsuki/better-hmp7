import struct
import threading
import unittest
from unittest.mock import patch

from better_hmp7.catalog import BY_ADDRESS, BY_KEY, MEASUREMENTS
from better_hmp7.probe import DeviceException, Probe, ProtocolError, crc16, decode, read_request


class Cable:
    """Synthetic RTU device: accepts the same identity and read frames as a probe."""
    def __init__(self):
        self.data = b""
        self.requests = []
        self.model = b"HMP7"
        self.online = 1
        self.corrupt = False

    def reset_input_buffer(self):
        self.data = b""

    def flush(self):
        pass

    def read(self,n):
        n = min(n,3)
        chunk,self.data = self.data[:n],self.data[n:]
        return chunk

    def write(self, frame):
        assert frame[-2:]==crc16(frame[:-2])
        self.requests.append(frame)
        if frame[1]==43:
            self.assert_identity(frame)
            answer=bytes.fromhex("f0 2b 0e 01 01 00 00 03")
            for n,name in enumerate((b"Vaisala",self.model,b"test-fw")):
                answer+=bytes([n,len(name)])+name
        else:
            assert frame[1]==3
            start,words=struct.unpack(">HH",frame[2:6])
            address=start
            payload=bytearray()
            while address<start+words:
                f=BY_ADDRESS[address]
                if address==64:
                    answer=bytes([240,0x83,2])
                    break
                if f.format=="float32":
                    v=struct.pack(">f",23.75 if f.key=="temperature" else 47.5)
                    data=v[2:]+v[:2]
                elif f.format=="int32":
                    data=b"\0"*4
                else:
                    val=self.online if f.key=="online_status" else int(f.key=="error_status")
                    data=struct.pack(">H",val)
                payload.extend(data)
                address+=f.words
            else:
                answer=bytes([240,3,len(payload)])+payload
        self.data=answer+crc16(answer)
        if self.corrupt:
            self.data=self.data[:-1]+bytes([self.data[-1]^0xff])
        return len(frame)

    @staticmethod
    def assert_identity(frame):
        assert frame[:-2]==bytes.fromhex("f0 2b 0e 01 00")


class ProbeTests(unittest.TestCase):
    def test_reference_frame_and_invalid_ranges(self):
        from better_hmp7.probe import validate
        request=read_request(0,2)
        self.assertEqual((request+crc16(request)).hex(),"f00300000002d12a")
        reply=bytes.fromhex("f003047ae141f46205")
        validate(reply,3)
        self.assertAlmostEqual(decode(reply[3:-2],BY_KEY["humidity"]),30.56,places=4)
        self.assertIsNone(decode(bytes.fromhex("00007fc0"),BY_KEY["humidity"]))
        for start,count in ((2,1),(4,2),(0x700,2),(0,0)):
            with self.assertRaises(ValueError):
                read_request(start,count)
        with self.assertRaises(ProtocolError):
            validate(bytes([1])+reply[1:],3)

    def test_sample_unsupported_lock_and_wrong_identity(self):
        bus=Cable()
        probe=Probe(bus,threading.Event())
        self.assertEqual(probe.identify(),"test-fw")
        sample=probe.sample()
        self.assertEqual(sample.measurements["temperature"],23.75)
        self.assertEqual(len(sample.measurements),18)
        self.assertEqual(len(sample.parameters),20)
        self.assertIsNone(sample.measurements["water_mass_fraction"])
        self.assertIn("water_mass_fraction",probe.unsupported)
        bus.online=0
        self.assertTrue(all(v is None for v in probe.sample().measurements.values()))
        bus.model=b"Other"
        with self.assertRaisesRegex(ProtocolError,"HMP7"):
            probe.identify()
        bus.corrupt=True
        with self.assertRaises(ProtocolError):
            probe.identify()

    def test_older_firmware_retries_supported_fields_in_block(self):
        bus=Cable()
        probe=Probe(bus,threading.Event())
        original=probe._registers
        def sparse(start,count):
            if start==0 and count==4:
                raise DeviceException(2)
            return original(start,count)
        with patch.object(probe,"_registers",sparse):
            values=probe._values(MEASUREMENTS)
        self.assertEqual(values["temperature"],23.75)
        self.assertEqual(values["humidity"],47.5)
        self.assertIn((0,4),probe.split)
