/**
 * Every corrupt `meshcore_nodes` row found on the dev rig (serial companion
 * on /dev/ttyUSB2), captured before the rows were deleted. `key` is the first
 * 8 bytes of the stored public key, `nameHex` the stored UTF-8 of the name,
 * `advType` the stored type. Some keys are real nodes whose name a spliced
 * frame overwrote (e.g. 1cbae49c = "KF4LZA EDC T1000", 123a100f = "K471
 * Portable", badd9bf1 = "DSoul-Bot"); the rest are phantom keys.
 */
export interface CorruptContactFixture {
  key: string;
  nameHex: string | null;
  advType: number;
}

export const CORRUPT_CONTACT_FIXTURES: CorruptContactFixture[] = [
  { key: '1cbae49c1bb7f268', nameHex: 'ec90be01', advType: 1 },
  { key: '0f67046175766171', nameHex: null, advType: 47 },
  { key: '39ff3f00fe000000', nameHex: null, advType: 62 },
  { key: '0f67046175766171', nameHex: null, advType: 104 },
  { key: '0000000000000000', nameHex: '521c2d23efbfbdefbfbd78efbfbdefbfbdefbfbdefbfbdc4beefbfbd02', advType: 79 },
  { key: '8f6ef823eb2d8088', nameHex: 'efbfbd01393827efbfbdefbfbd32546a3eefbfbd', advType: 0 },
  { key: '1cb1382ce75309d0', nameHex: 'efbfbdefbfbd22efbfbdefbfbdefbfbd13c9a6cba5c889efbfbdefbfbd7cefbfbdefbfbdc9adefbfbd3f01', advType: 0 },
  { key: '356d4a714bb2da18', nameHex: null, advType: 128 },
  { key: '0065000000935a8c', nameHex: null, advType: 92 },
  { key: '82aa203f27040035', nameHex: null, advType: 124 },
  { key: '55b0403d9512e539', nameHex: null, advType: 240 },
  { key: 'd7eb45002f000000', nameHex: 'efbfbd120cefbfbdefbfbd1e56efbfbdefbfbd246213efbfbdefbfbdefbfbd3471efbfbd5a276238037d492003efbfbdefbfbd5002', advType: 0 },
  { key: 'd7eb452a2f0c589b', nameHex: 'efbfbd47efbfbd085479efbfbdefbfbd10efbfbd4402', advType: 45 },
  { key: '03586b005d000000', nameHex: '0544efbfbd3defbfbdefbfbdefbfbd01', advType: 115 },
  { key: '113b675720e83e70', nameHex: null, advType: 102 },
  { key: '65af6c10e0cdc747', nameHex: null, advType: 240 },
  { key: '761312007b000000', nameHex: null, advType: 148 },
  { key: '617cf109004e0000', nameHex: null, advType: 133 },
  { key: '5284ba4eaf5ec5f6', nameHex: null, advType: 203 },
  { key: '99f9b7d6c8889f3d', nameHex: '7237efbfbdefbfbd655347115b79efbfbdefbfbdefbfbdefbfbd02', advType: 76 },
  { key: '69a27000cb000000', nameHex: null, advType: 119 },
  { key: 'b65df6020c931108', nameHex: null, advType: 109 },
  { key: '02ef26f8047b44be', nameHex: '7e6a17efbfbdefbfbd01efbfbdefbfbd35efbfbdefbfbd3a7e6a3eefbfbd', advType: 1 },
  { key: '3752a59b252902aa', nameHex: '5c39efbfbdefbfbd3b6f663eefbfbd', advType: 0 },
  { key: '4a3fd47c2eba246e', nameHex: null, advType: 201 },
  { key: '5c6be7cff5537912', nameHex: 'efbfbdefbfbdefbfbd3cefbfbd5befbfbdd08cefbfbd6eefbfbd3f1b4defbfbd45efbfbd0eefbfbdefbfbd01', advType: 0 },
  { key: '3412c4f100a40000', nameHex: null, advType: 123 },
  { key: '4a3fd47c2eba246e', nameHex: null, advType: 38 },
  { key: 'd057be5dd43bc4a3', nameHex: 'efbfbd663eefbfbd', advType: 0 },
  { key: '6ce765a0058477d3', nameHex: 'efbfbd203cefbfbdefbfbd4befbfbddda24701', advType: 111 },
  { key: 'ec764a7037cdbaef', nameHex: null, advType: 216 },
  { key: 'ab6813b93b34805c', nameHex: 'efbfbdefbfbd13efbfbd1c145befbfbd65efbfbdefbfbdc48a6aefbfbdefbfbdefbfbd4756efbfbd541a4a01', advType: 0 },
  { key: 'b65df6120cb5941e', nameHex: null, advType: 146 },
  { key: '0f67046175766171', nameHex: null, advType: 196 },
  { key: '3e98940003baa443', nameHex: null, advType: 97 },
  { key: '5c6be7cff5537912', nameHex: null, advType: 167 },
  { key: '6288e0fec46d34d1', nameHex: 'efbfbdefbfbd4972efbfbd2fefbfbd38efbfbdefbfbd24efbfbdefbfbdefbfbd09efbfbd03efbfbd35efbfbd5948efbfbdefbfbdefbfbd0b3975efbfbd5201', advType: 0 },
  { key: 'fe6ef06120563420', nameHex: null, advType: 171 },
  { key: '8ff6a55dc3169372', nameHex: null, advType: 58 },
  { key: 'cefc56843958dc4a', nameHex: 'efbfbdefbfbd550eefbfbd5b2d0542770c02', advType: 48 },
  { key: 'aff1946f38a98341', nameHex: 'efbfbdefbfbdefbfbd6aefbfbdefbfbdefbfbd0174efbfbd38efbfbd', advType: 0 },
  { key: '6ce765a0058477d3', nameHex: null, advType: 13 },
  { key: '71e4c54e06046979', nameHex: 'efbfbdefbfbd01', advType: 0 },
  { key: 'cefc56843958734a', nameHex: null, advType: 175 },
  { key: '02ef26f8047b44be', nameHex: '35efbfbd7a4e756a3eefbfbd', advType: 0 },
  { key: 'b65df6120cb5cf1e', nameHex: '6e7cefbfbd6a3eefbfbd', advType: 0 },
  { key: 'c85de7b801258275', nameHex: '7c02', advType: 0 },
  { key: '71e46a4e00000000', nameHex: null, advType: 63 },
  { key: '63083fb527ef9c74', nameHex: '7aefbfbdefbfbd5d167e0301', advType: 101 },
  { key: '86f8406624e943b0', nameHex: null, advType: 132 },
  { key: '1055c57d616c20da', nameHex: null, advType: 34 },
  { key: '6028002600000000', nameHex: 'efbfbdd18fefbfbdefbfbd307648efbfbd68efbfbdefbfbd08166d050b661101', advType: 0 },
  { key: 'f44873471d518102', nameHex: '5cefbfbd264aefbfbd0e0befbfbd2c73', advType: 0 },
  { key: '594569bff8f9f160', nameHex: null, advType: 237 },
  { key: '01b6126c052900af', nameHex: 'efbfbd4cefbfbd31efbfbdefbfbd5eefbfbdefbfbd1641efbfbd2550efbfbd305102', advType: 67 },
  { key: '113b670020000000', nameHex: 'efbfbdefbfbdefbfbd6aefbfbdefbfbd014c6436efbfbdefbfbdefbfbdefbfbd6a3eefbfbd', advType: 0 },
  { key: '9605f9369bebe878', nameHex: 'efbfbdefbfbd5c01', advType: 0 },
  { key: '9eebd500ab000000', nameHex: '02', advType: 0 },
  { key: '8f6ef823eb2d8088', nameHex: '7c02', advType: 0 },
  { key: 'cefc56843958dc4a', nameHex: null, advType: 117 },
  { key: '123a100f1dc62733', nameHex: '4b3437efbfbd2024efbfbd44efbfbdefbfbd4e6defbfbd02', advType: 1 },
  { key: 'badd9bf1b42145cd', nameHex: '3eefbfbd', advType: 0 },
  { key: 'bb45de0033000000', nameHex: '6a3eefbfbd', advType: 0 },
  { key: '7302931108f5599a', nameHex: 'ce876a3eefbfbd', advType: 0 },
  { key: 'd83cc0ed8f9df940', nameHex: '7c6a3eefbfbd', advType: 0 },
  { key: '8f6ef823eb2d8088', nameHex: '3eefbfbd', advType: 0 },
  { key: '79de2e3db3a80185', nameHex: '25efbfbd6a3eefbfbd', advType: 0 },
];

/** Real names from the same DB that must survive (hex of stored UTF-8). */
export const REAL_NAME_FIXTURES: Array<{ nameHex: string; clean: string }> = [
  // Sender's trailing multi-byte char was clipped before it reached us.
  { nameHex: '4476796e736f756c20474154353632204261736520efbfbd', clean: 'Dvynsoul GAT562 Base' },
  { nameHex: '4b46344c5a4120454443205431303030', clean: 'KF4LZA EDC T1000' },
  { nameHex: '4b34373120506f727461626c65', clean: 'K471 Portable' },
  { nameHex: '44536f756c2d426f74', clean: 'DSoul-Bot' },
];
