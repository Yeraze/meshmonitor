/**
 * TypeScript port of the MCOimg v3 (IM3) encoder, Normal and High levels.
 *
 * Ported from https://github.com/HDDen/meshcore-open (branch rename-mco-advanced)
 *   commit c38c1650fe8394835e333b5b4a1ac84ead2d5e5a
 *   file   docs/mcoimg-js/mcoimg-v3-codec.global.js, lines 4021-5062
 *          (regions: components, splits, greedy rectangles, beam search, region bodies, shared palettes, plans, region candidates, layout cost; Extreme search, the reduced-cost evaluator (fastRegionPayloadByteCostEncoder, 4386-4405), the exact re-rank block and progress callbacks (4619-4622) are not ported)
 *
 * Logic, function names, order, checks and error messages follow the upstream
 * file; only types were added. Output-neutral changes are marked in comments.
 *
 * MIT License
 *
 * Copyright (c) 2025 zjs81
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type { Bounds, V3Image, EncodeOptions, RegionState, RegionPlanCache, RegionBodyResult, RegionSplit, PreparedRegion, RegionBlock, SharedPaletteVariants, RegionPlan, RegionNeighbor } from './types.js';
import type { McoImageV3BlockAlgorithmId, ScanModeId } from '../constants.js';
import { McoImageV3Container as MCOImageV3Container } from '../constants.js';
import { McoImageV3ContainerName as MCOImageV3ContainerName } from '../constants.js';
import { localBits, canUseCompactBlockHeader } from '../validate.js';
import { isDynamicProfile } from '../palettes.js';
import { rowLengthForScan } from '../blockBodies.js';
import {
  HYBRID_COMMON_REGION_ALGORITHM_MARKER,
  MAX_REGIONS,
  ScanMode,
} from '../constants.js';
import { McoImageV3InvalidInputError as MCOImageV3InvalidInputError, McoImageV3CodecError as MCOImageV3CodecError } from '../errors.js';
import { McoImageV3BlockAlgorithm as MCOImageV3BlockAlgorithm } from '../constants.js';
import { BitWriter } from './bitWriter.js';
import { writeAdaptiveBitplanesBody, writeLegacyBitplanesBody } from './bitplanes.js';
import { biColorForeground, writeBlockBodyEncoder, writeQuadtreeNodeEncoder, writeRowRepeatEncoder } from './blockBody.js';
import { buildRuns, imageModeForAlgorithm, isImplicitWhiteBackground, localIndexMap, makeCandidate, modeTieRank, sparseAnalysis, toScanOrder, writeBackgroundRef, writeColorRef, writeDeltaRegionGeometry, writeImagePreamble, writeRegionGeometry } from './common.js';
import { localPaletteVariants, writeLocalPalette } from './localPaletteWriter.js';
import { buildGreedyLzTokens, buildOptimalLzTokens, lzTokensBitCost, writeLzTokens } from './lz.js';
import { writeCompactRowDeltaBodyEncoder, writeRowDeltaBodyEncoder } from './rowDelta.js';
import { FULL_REGION_BLOCK_ALGORITHMS, FULL_REGION_OPTIONS, FULL_SHARED_REGION_ALGORITHMS, ImageMode, MAX_BEAM_REGION_PIXELS, NORMAL_MAX_REGIONS, NORMAL_REGION_BLOCK_ALGORITHMS, NORMAL_REGION_OPTIONS, NORMAL_SHARED_REGION_ALGORITHMS, REGION_BEAM_DEPTH, REGION_BEAM_NEIGHBORS, REGION_BEAM_WIDTH } from './tables.js';
import { caches } from './common.js';

function isPresent<T>(value: T | null): value is T {
  return value != null;
}

export function sortRegionsEncoder(regions: Bounds[]) {
  return Array.from(regions, (region) => ({ ...region })).sort((left, right) =>
    (left.y - right.y) || (left.x - right.x) ||
    (left.height - right.height) || (left.width - right.width));
}

export function regionListKeyEncoder(regions: Bounds[]) {
  return regions.map((region) =>
    `${region.x},${region.y},${region.width},${region.height}`).join(';');
}

export function regionAreaEncoder(region: Bounds) {
  return region.width * region.height;
}

export function findComponentRegionsEncoder(pixels: number[], width: number, height: number, background: number) {
  const visited = new Uint8Array(pixels.length), regions: Bounds[] = [];
  const neighbors = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];
  for (let start = 0; start < pixels.length; start++) {
    if (visited[start] || pixels[start] === background) continue;
    let minX = start % width, maxX = minX, minY = Math.floor(start / width), maxY = minY;
    const queue: number[] = [start]; visited[start] = 1;
    while (queue.length) {
      const index = queue.pop() as number, x = index % width, y = Math.floor(index / width);
      minX = Math.min(minX,x); maxX = Math.max(maxX,x); minY = Math.min(minY,y); maxY = Math.max(maxY,y);
      for (const [dx,dy] of neighbors) {
        const nx=x+dx, ny=y+dy;
        if (nx<0||ny<0||nx>=width||ny>=height) continue;
        const next=ny*width+nx;
        if (!visited[next] && pixels[next] !== background) { visited[next]=1; queue.push(next); }
      }
    }
    regions.push({ x:minX,y:minY,width:maxX-minX+1,height:maxY-minY+1 });
  }
  regions.sort((a,b)=>(a.y-b.y)||(a.x-b.x));
  return regions;
}

export function regionsDoNotOverlapEncoder(regions: Bounds[]) {
  for (let i=0;i<regions.length;i++) for (let j=i+1;j<regions.length;j++) {
    const a=regions[i],b=regions[j];
    if (a.x < b.x+b.width && a.x+a.width > b.x && a.y < b.y+b.height && a.y+a.height > b.y) return false;
  }
  return true;
}

export function sameRegionListEncoder(left: Bounds[], right: Bounds[]) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const a = left[index], b = right[index];
    if (a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height) return false;
  }
  return true;
}

export function tightBoundsInRectEncoder(pixels: number[], fullWidth: number, background: number, rect: Bounds) {
  if (rect.width <= 0 || rect.height <= 0) return null;
  let minX = rect.x + rect.width, minY = rect.y + rect.height;
  let maxX = rect.x - 1, maxY = rect.y - 1;
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      if (pixels[y * fullWidth + x] === background) continue;
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  return maxX < minX || maxY < minY
    ? null
    : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export function regionRowNonBackgroundCountEncoder(pixels: number[], fullWidth: number, background: number, region: Bounds, y: number) {
  let count = 0;
  for (let x = region.x; x < region.x + region.width; x++) {
    if (pixels[y * fullWidth + x] !== background) count++;
  }
  return count;
}

export function regionColumnNonBackgroundCountEncoder(pixels: number[], fullWidth: number, background: number, region: Bounds, x: number) {
  let count = 0;
  for (let y = region.y; y < region.y + region.height; y++) {
    if (pixels[y * fullWidth + x] !== background) count++;
  }
  return count;
}

export function partitionIfUsefulEncoder(original: Bounds, parts: Bounds[]): RegionSplit | null {
  if (parts.length < 2) return null;
  const savedArea = regionAreaEncoder(original) - parts.reduce((sum, part) => sum + regionAreaEncoder(part), 0);
  return savedArea > 0 ? { parts, savedArea } : null;
}

export function betterRegionPartitionEncoder(left: RegionSplit | null, right: RegionSplit | null) {
  if (left == null) return right;
  if (right == null) return left;
  return left.savedArea >= right.savedArea ? left : right;
}

export function bestEmptyRowSplitEncoder(pixels: number[], fullWidth: number, background: number, region: Bounds) {
  let best: RegionSplit | null = null;
  for (let y = region.y; y < region.y + region.height; y++) {
    if (regionRowNonBackgroundCountEncoder(pixels, fullWidth, background, region, y) !== 0) continue;
    const parts = [
      tightBoundsInRectEncoder(pixels, fullWidth, background,
        { x: region.x, y: region.y, width: region.width, height: y - region.y }),
      tightBoundsInRectEncoder(pixels, fullWidth, background,
        { x: region.x, y: y + 1, width: region.width, height: region.y + region.height - y - 1 }),
    ].filter(isPresent);
    const partition = partitionIfUsefulEncoder(region, parts);
    if (partition && (best == null || partition.savedArea > best.savedArea)) best = partition;
  }
  return best;
}

export function bestEmptyColumnSplitEncoder(pixels: number[], fullWidth: number, background: number, region: Bounds) {
  let best: RegionSplit | null = null;
  for (let x = region.x; x < region.x + region.width; x++) {
    if (regionColumnNonBackgroundCountEncoder(pixels, fullWidth, background, region, x) !== 0) continue;
    const parts = [
      tightBoundsInRectEncoder(pixels, fullWidth, background,
        { x: region.x, y: region.y, width: x - region.x, height: region.height }),
      tightBoundsInRectEncoder(pixels, fullWidth, background,
        { x: x + 1, y: region.y, width: region.x + region.width - x - 1, height: region.height }),
    ].filter(isPresent);
    const partition = partitionIfUsefulEncoder(region, parts);
    if (partition && (best == null || partition.savedArea > best.savedArea)) best = partition;
  }
  return best;
}

export function splitRegionByBestEmptyLineEncoder(pixels: number[], fullWidth: number, background: number, region: Bounds, output: Bounds[], maxRegions: number) {
  const split = betterRegionPartitionEncoder(
    bestEmptyRowSplitEncoder(pixels, fullWidth, background, region),
    bestEmptyColumnSplitEncoder(pixels, fullWidth, background, region),
  );
  if (!split) { output.push(region); return; }
  for (const part of split.parts) {
    splitRegionByBestEmptyLineEncoder(pixels, fullWidth, background, part, output, maxRegions);
    if (output.length > maxRegions) return;
  }
}

export function splitRegionsByEmptyLinesEncoder(pixels: number[], fullWidth: number, background: number, regions: Bounds[], maxRegions: number) {
  const output: Bounds[] = [];
  for (const region of regions) {
    splitRegionByBestEmptyLineEncoder(pixels, fullWidth, background, region, output, maxRegions);
    if (output.length > maxRegions) return [];
  }
  return sameRegionListEncoder(output, regions) ? [] : output;
}

export function bestSparseRowSplitEncoder(pixels: number[], fullWidth: number, background: number, region: Bounds, maxLineNonBackground: number) {
  let best: RegionSplit | null = null, y = region.y;
  while (y < region.y + region.height) {
    const count = regionRowNonBackgroundCountEncoder(pixels, fullWidth, background, region, y);
    if (count > maxLineNonBackground) { y++; continue; }
    const startY = y;
    while (y < region.y + region.height &&
        regionRowNonBackgroundCountEncoder(pixels, fullWidth, background, region, y) <= maxLineNonBackground) y++;
    const endY = y - 1;
    const parts = [
      tightBoundsInRectEncoder(pixels, fullWidth, background,
        { x: region.x, y: region.y, width: region.width, height: startY - region.y }),
      tightBoundsInRectEncoder(pixels, fullWidth, background,
        { x: region.x, y: startY, width: region.width, height: endY - startY + 1 }),
      tightBoundsInRectEncoder(pixels, fullWidth, background,
        { x: region.x, y: endY + 1, width: region.width, height: region.y + region.height - endY - 1 }),
    ].filter(isPresent);
    const partition = partitionIfUsefulEncoder(region, parts);
    if (partition && (best == null || partition.savedArea > best.savedArea)) best = partition;
  }
  return best;
}

export function bestSparseColumnSplitEncoder(pixels: number[], fullWidth: number, background: number, region: Bounds, maxLineNonBackground: number) {
  let best: RegionSplit | null = null, x = region.x;
  while (x < region.x + region.width) {
    const count = regionColumnNonBackgroundCountEncoder(pixels, fullWidth, background, region, x);
    if (count > maxLineNonBackground) { x++; continue; }
    const startX = x;
    while (x < region.x + region.width &&
        regionColumnNonBackgroundCountEncoder(pixels, fullWidth, background, region, x) <= maxLineNonBackground) x++;
    const endX = x - 1;
    const parts = [
      tightBoundsInRectEncoder(pixels, fullWidth, background,
        { x: region.x, y: region.y, width: startX - region.x, height: region.height }),
      tightBoundsInRectEncoder(pixels, fullWidth, background,
        { x: startX, y: region.y, width: endX - startX + 1, height: region.height }),
      tightBoundsInRectEncoder(pixels, fullWidth, background,
        { x: endX + 1, y: region.y, width: region.x + region.width - endX - 1, height: region.height }),
    ].filter(isPresent);
    const partition = partitionIfUsefulEncoder(region, parts);
    if (partition && (best == null || partition.savedArea > best.savedArea)) best = partition;
  }
  return best;
}

export function splitRegionByBestSparseLineEncoder(pixels: number[], fullWidth: number, background: number, region: Bounds, output: Bounds[], maxRegions: number, maxLineNonBackground: number) {
  const split = betterRegionPartitionEncoder(
    bestSparseRowSplitEncoder(pixels, fullWidth, background, region, maxLineNonBackground),
    bestSparseColumnSplitEncoder(pixels, fullWidth, background, region, maxLineNonBackground),
  );
  if (!split) { output.push(region); return; }
  for (const part of split.parts) {
    splitRegionByBestSparseLineEncoder(
      pixels, fullWidth, background, part, output, maxRegions, maxLineNonBackground,
    );
    if (output.length > maxRegions) return;
  }
}

export function splitRegionsBySparseLinesEncoder(pixels: number[], fullWidth: number, background: number, regions: Bounds[], maxRegions: number, maxLineNonBackground: number) {
  const output: Bounds[] = [];
  for (const region of regions) {
    splitRegionByBestSparseLineEncoder(
      pixels, fullWidth, background, region, output, maxRegions, maxLineNonBackground,
    );
    if (output.length > maxRegions) return [];
  }
  return sameRegionListEncoder(output, regions) ? [] : output;
}

export function greedyRectRegionVariantsEncoder(pixels: number[], width: number, height: number, background: number, maxRegions: number, firstOnly = false) {
  const strategies = [[1,1,0],[1,1,1],[1,1,2],[-1,1,0],[1,-1,0],[-1,-1,0]];
  const output: Bounds[][]=[], seen=new Set<string>();
  const runLength=(covered: Uint8Array,x: number,y: number,h: number)=>{let n=0;for(let xx=x;xx>=0&&xx<width;xx+=h){const i=y*width+xx;if(covered[i]||pixels[i]===background)break;n++;}return n;};
  for (const [h,v,tie] of strategies) {
    const covered=new Uint8Array(pixels.length), regions: Bounds[]=[];
    while (true) {
      let start=-1;
      for(let y=v>0?0:height-1;y!==(v>0?height:-1)&&start<0;y+=v) for(let x=h>0?0:width-1;x!==(h>0?width:-1);x+=h){const i=y*width+x;if(!covered[i]&&pixels[i]!==background){start=i;break;}}
      if(start<0)break;
      const sx=start%width, sy=Math.floor(start/width);
      let bestW=1,bestH=1,maxW=runLength(covered,sx,sy,h);
      for(let ch=1;;ch++){
        const y=sy+(ch-1)*v;if(y<0||y>=height)break;
        const rw=runLength(covered,sx,y,h);if(rw===0)break;maxW=Math.min(maxW,rw);
        const area=maxW*ch,bestArea=bestW*bestH;
        if(area>bestArea||(area===bestArea&&((tie===1&&maxW>bestW)||(tie===2&&ch>bestH)||(tie===0&&ch>bestH)))){bestW=maxW;bestH=ch;}
      }
      const rect={x:h>0?sx:sx-bestW+1,y:v>0?sy:sy-bestH+1,width:bestW,height:bestH};
      regions.push(rect); if(regions.length>maxRegions){regions.length=0;break;}
      for(let y=rect.y;y<rect.y+rect.height;y++)for(let x=rect.x;x<rect.x+rect.width;x++)covered[y*width+x]=1;
    }
    if(!regions.length)continue;
    const sorted = sortRegionsEncoder(regions);
    const key=regionListKeyEncoder(sorted);
    if(!seen.has(key)){
      seen.add(key);output.push(sorted);
      if (firstOnly) break;
    }
  }
  return output;
}

export function unionBoundsEncoder(left: Bounds, right: Bounds) {
  const x = Math.min(left.x, right.x), y = Math.min(left.y, right.y);
  const maxX = Math.max(left.x + left.width, right.x + right.width);
  const maxY = Math.max(left.y + left.height, right.y + right.height);
  return { x, y, width: maxX - x, height: maxY - y };
}

export function tightSplitRegionEncoder(pixels: number[], fullWidth: number, background: number, region: Bounds, vertical: boolean, cut: number) {
  const first = vertical
    ? { x: region.x, y: region.y, width: cut, height: region.height }
    : { x: region.x, y: region.y, width: region.width, height: cut };
  const second = vertical
    ? { x: region.x + cut, y: region.y, width: region.width - cut, height: region.height }
    : { x: region.x, y: region.y + cut, width: region.width, height: region.height - cut };
  return [
    tightBoundsInRectEncoder(pixels, fullWidth, background, first),
    tightBoundsInRectEncoder(pixels, fullWidth, background, second),
  ].filter(isPresent);
}

export function regionBeamNeighborsEncoder(pixels: number[], fullWidth: number, background: number, regions: Bounds[], maxRegions: number) {
  const mergeNeighbors: RegionNeighbor[] = [];
  if (regions.length > 1) {
    for (let left = 0; left < regions.length - 1; left++) {
      for (let right = left + 1; right < regions.length; right++) {
        const merged = unionBoundsEncoder(regions[left], regions[right]);
        const candidate = regions.filter((_, index) => index !== left && index !== right).concat([merged]);
        if (!regionsDoNotOverlapEncoder(candidate)) continue;
        const addedArea = regionAreaEncoder(merged) - regionAreaEncoder(regions[left]) - regionAreaEncoder(regions[right]);
        mergeNeighbors.push({ regions: sortRegionsEncoder(candidate), heuristic: addedArea });
      }
    }
  }
  mergeNeighbors.sort((left, right) => left.heuristic - right.heuristic);

  const splitNeighbors: RegionNeighbor[] = [];
  if (regions.length < maxRegions) {
    for (let index = 0; index < regions.length; index++) {
      const region = regions[index];
      for (let cut = 1; cut < region.width; cut++) {
        const parts = tightSplitRegionEncoder(pixels, fullWidth, background, region, true, cut);
        addRegionSplitNeighborEncoder(splitNeighbors, regions, index, region, parts);
      }
      for (let cut = 1; cut < region.height; cut++) {
        const parts = tightSplitRegionEncoder(pixels, fullWidth, background, region, false, cut);
        addRegionSplitNeighborEncoder(splitNeighbors, regions, index, region, parts);
      }
    }
  }
  splitNeighbors.sort((left, right) => left.heuristic - right.heuristic);

  const result: Bounds[][] = [], seen = new Set<string>();
  const neighborLimit = REGION_BEAM_NEIGHBORS;
  const perKindLimit = Math.max(1, Math.floor(neighborLimit / 2));
  for (const neighbor of mergeNeighbors.slice(0, perKindLimit).concat(splitNeighbors.slice(0, perKindLimit))) {
    const key = regionListKeyEncoder(neighbor.regions);
    if (!seen.has(key)) { seen.add(key); result.push(neighbor.regions); }
  }
  return result;
}

export function addRegionSplitNeighborEncoder(output: RegionNeighbor[], regions: Bounds[], replacedIndex: number, original: Bounds, parts: Bounds[]) {
  if (parts.length !== 2) return;
  const savedArea = regionAreaEncoder(original) - regionAreaEncoder(parts[0]) - regionAreaEncoder(parts[1]);
  if (savedArea <= 0) return;
  const candidate = regions.filter((_, index) => index !== replacedIndex).concat(parts);
  if (!regionsDoNotOverlapEncoder(candidate)) return;
  output.push({ regions: sortRegionsEncoder(candidate), heuristic: -savedArea });
}

export function exactRegionPayloadCostEncoder(image: V3Image, background: number, regions: Bounds[], high: boolean) {
  const planCache = regionPlanCacheEncoder(image, background, regions, high);
  let best = tryBuildRegionsCandidateEncoder(image, background, 0, regions, {
    compactGeometry: false,
    commonBlockHeader: false,
    hybridCommonHeader: false,
    deltaGeometry: false,
    sharedLocalPalette: false,
  }, high, planCache);
  for (const options of (high ? FULL_REGION_OPTIONS : NORMAL_REGION_OPTIONS)) {
    const candidate = tryBuildRegionsCandidateEncoder(image, background, 0, regions, {
      compactGeometry: true,
      ...options,
    }, high, planCache);
    if (candidate && (!best || candidate.byteLength < best.byteLength)) best = candidate;
  }
  return best ? { cost: best.byteLength, planCache } : null;
}

export function normalSharedCompactRegionPayloadCostEncoder(image: V3Image, background: number, regions: Bounds[]) {
  const planCache = regionPlanCacheEncoder(image, background, regions, false);
  let best = null;
  for (const options of NORMAL_REGION_OPTIONS) {
    if (!options.sharedLocalPalette) continue;
    const candidate = tryBuildRegionsCandidateEncoder(image, background, 0, regions, {
      compactGeometry: true,
      ...options,
    }, false, planCache);
    if (candidate && (!best || candidate.byteLength < best.byteLength)) best = candidate;
  }
  return best ? { cost: best.byteLength, planCache } : null;
}

export function findPayloadOptimizedRegionVariantsEncoder(image: V3Image, background: number, initialVariants: Bounds[][], maxRegions: number, high: boolean) {
  const initialStates: RegionState[] = [], seen = new Set<string>();
  for (const regions of initialVariants) {
    if (!regions.length || regions.length > maxRegions || !regionsDoNotOverlapEncoder(regions)) continue;
    const normalized = sortRegionsEncoder(regions), key = regionListKeyEncoder(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    const cost = exactRegionPayloadCostEncoder(image, background, normalized, high)?.cost ?? null;
    if (cost != null) initialStates.push({ regions: normalized, cost, exactPlanCache: null });
  }
  if (!initialStates.length) return [];
  initialStates.sort((left, right) => left.cost - right.cost);
  const bestExistingCost = initialStates[0].cost;
  const beamWidth = REGION_BEAM_WIDTH;
  const beamDepth = REGION_BEAM_DEPTH;
  const resultLimit = REGION_BEAM_WIDTH;
  let beam = initialStates.slice(0, beamWidth);
  const improved: RegionState[] = [];

  for (let depth = 0; depth < beamDepth; depth++) {
    const next: RegionState[] = [];
    for (const state of beam) {
      for (const regions of regionBeamNeighborsEncoder(
        image.pixels, image.width, background, state.regions, maxRegions,
      )) {
        const key = regionListKeyEncoder(regions);
        if (seen.has(key)) continue;
        seen.add(key);
        const cost = exactRegionPayloadCostEncoder(image, background, regions, high)?.cost ?? null;
        if (cost == null) continue;
        const candidate: RegionState = { regions, cost, exactPlanCache: null };
        next.push(candidate);
        if (cost < bestExistingCost) improved.push(candidate);
      }
    }
    if (!next.length) break;
    next.sort((left, right) => left.cost - right.cost);
    beam = next.slice(0, beamWidth);
  }

  const source = improved;
  source.sort((left, right) => left.cost - right.cost);
  const reducedResult: RegionState[] = [], resultKeys = new Set<string>();
  const reducedLimit = resultLimit;
  for (const state of source) {
    const key = regionListKeyEncoder(state.regions);
    if (!resultKeys.has(key)) { resultKeys.add(key); reducedResult.push(state); }
    if (reducedResult.length >= reducedLimit) break;
  }
  return reducedResult;
}

export function findNormalSharedCompactRegionVariantsEncoder(image: V3Image, background: number, initialVariants: Bounds[][], maxRegions: number) {
  const initialStates = [], seen = new Set();
  for (const regions of initialVariants) {
    if (!regions.length || regions.length > maxRegions || !regionsDoNotOverlapEncoder(regions)) continue;
    const normalized = sortRegionsEncoder(regions), key = regionListKeyEncoder(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    const exact = normalSharedCompactRegionPayloadCostEncoder(image, background, normalized);
    if (exact) initialStates.push({ regions: normalized, cost: exact.cost, exactPlanCache: exact.planCache });
  }
  if (!initialStates.length) return [];
  initialStates.sort((left, right) => left.cost - right.cost);
  const bestExistingCost = initialStates[0].cost;
  let beam = initialStates.slice(0, REGION_BEAM_WIDTH);
  const improved = [];
  for (let depth = 0; depth < REGION_BEAM_DEPTH; depth++) {
    const next = [];
    for (const state of beam) {
      for (const regions of regionBeamNeighborsEncoder(
        image.pixels, image.width, background, state.regions, maxRegions,
      )) {
        const key = regionListKeyEncoder(regions);
        if (seen.has(key)) continue;
        seen.add(key);
        const exact = normalSharedCompactRegionPayloadCostEncoder(image, background, regions);
        if (!exact) continue;
        const candidate = { regions, cost: exact.cost, exactPlanCache: exact.planCache };
        next.push(candidate);
        if (candidate.cost < bestExistingCost) improved.push(candidate);
      }
    }
    if (!next.length) break;
    next.sort((left, right) => left.cost - right.cost);
    beam = next.slice(0, REGION_BEAM_WIDTH);
  }
  improved.sort((left, right) => left.cost - right.cost);
  const result = [], resultKeys = new Set();
  for (const state of improved) {
    const key = regionListKeyEncoder(state.regions);
    if (!resultKeys.has(key)) { resultKeys.add(key); result.push(state); }
    if (result.length >= REGION_BEAM_WIDTH) break;
  }
  return result;
}

export function regionVariantsEncoder(image: V3Image, backgroundColor: number, maxRegions: number, high: boolean) {
  if (maxRegions === 0) return [];
  const connected = findComponentRegionsEncoder(image.pixels, image.width, image.height, backgroundColor);
  if (!connected.length) return [];
  const beamMaxRegions = maxRegions;
  const raw: Array<{ regions: Bounds[]; label: string | null }> = [{ regions: connected, label: null }];
  const split = splitRegionsByEmptyLinesEncoder(
    image.pixels, image.width, backgroundColor, connected, maxRegions,
  );
  if (split.length) raw.push({ regions: split, label: 'split' });
  const sparseSplit = splitRegionsBySparseLinesEncoder(
    image.pixels, image.width, backgroundColor, connected, maxRegions, 2,
  );
  if (sparseSplit.length) raw.push({ regions: sparseSplit, label: 'sparse-split' });
  for (const regions of greedyRectRegionVariantsEncoder(
    image.pixels, image.width, image.height, backgroundColor, maxRegions, !high,
  )) raw.push({ regions, label: 'greedy' });

  const variants = [], seen = new Set();
  for (const variant of raw) {
    const regions = sortRegionsEncoder(variant.regions);
    if (!regions.length || regions.length > maxRegions || !regionsDoNotOverlapEncoder(regions)) continue;
    const key = regionListKeyEncoder(regions);
    if (!seen.has(key)) { seen.add(key); variants.push({ regions, label: variant.label, planCache: null }); }
  }

  if (high && variants.length && image.pixels.length <= MAX_BEAM_REGION_PIXELS) {
    const beamVariants = findPayloadOptimizedRegionVariantsEncoder(
      image, backgroundColor, variants.map((variant) => variant.regions),
      beamMaxRegions, true,
    );
    for (const state of beamVariants) {
      const key = regionListKeyEncoder(state.regions);
      if (!seen.has(key)) {
        seen.add(key);
        variants.push({ regions: state.regions, label: 'beam', planCache: state.exactPlanCache });
      }
    }
  }

  if (!high && variants.length && image.pixels.length <= MAX_BEAM_REGION_PIXELS) {
    const beamVariants = findNormalSharedCompactRegionVariantsEncoder(
      image, backgroundColor, variants.map((variant) => variant.regions), beamMaxRegions,
    );
    for (const state of beamVariants) {
      const key = regionListKeyEncoder(state.regions);
      if (!seen.has(key)) {
        seen.add(key);
        variants.push({ regions: state.regions, label: 'beam', planCache: state.exactPlanCache });
      }
    }
  }
  return variants;
}

export function extractRegionPixelsEncoder(image: V3Image, bounds: Bounds) {
  const pixels=[];
  for(let y=0;y<bounds.height;y++){
    const start=(bounds.y+y)*image.width+bounds.x;
    for(let x=0;x<bounds.width;x++)pixels.push(image.pixels[start+x]);
  }
  return pixels;
}

export function regionHeaderBitCost(algorithm: McoImageV3BlockAlgorithmId) { return 5 + (canUseCompactBlockHeader(algorithm) ? 0 : 2); }


export function tryRegionBodyEncoder(image: V3Image, rowMajor: number[], bounds: Bounds, algorithm: McoImageV3BlockAlgorithmId, scan: ScanModeId, backgroundColor: number, high: boolean, sharedPalette: number[] | null) {
  if(algorithm===MCOImageV3BlockAlgorithm.quadtree&&scan!==ScanMode.h)return null;
  if(canUseCompactBlockHeader(algorithm)&&scan!==ScanMode.h)return null;
  const cacheKey = caches.regionBody == null ? null : [
    image.paletteProfile, bounds.width, bounds.height, algorithm, scan, backgroundColor,
    high ? 1 : 0, sharedPalette ? sharedPalette.join('.') : '-', rowMajor.join('.'),
  ].join('|');
  if (cacheKey != null && caches.regionBody!.has(cacheKey)) return caches.regionBody!.get(cacheKey) as RegionBodyResult | null;
  const linear=toScanOrder(rowMajor,bounds.width,bounds.height,scan);
  const writer=new BitWriter();
  try {
    if(sharedPalette) writeBlockBodyWithSharedPaletteEncoder(writer,linear,algorithm,sharedPalette,{
      backgroundColor,rowLength:rowLengthForScan(scan,bounds.width,bounds.height),greedyLzOnly:!high,
    });
    else writeBlockBodyEncoder(writer,linear,image.paletteProfile,algorithm,{
      backgroundColor,rowLength:rowLengthForScan(scan,bounds.width,bounds.height),backgroundInherited:true,
      greedyLzOnly:!high,useHighCompressionExtras:high,
    });
  } catch(error){if(error instanceof MCOImageV3CodecError)return null;throw error;}
  const bodyBitLength = writer.bitLength;
  if(bodyBitLength===0){ if(cacheKey!=null)caches.regionBody!.set(cacheKey,null); return null; }
  const result = {algorithm,scan,bytes:writer.toBytes(),bitLength:bodyBitLength};
  if(cacheKey!=null)caches.regionBody!.set(cacheKey,result);
  return result;
}

export function writeBlockBodyWithSharedPaletteEncoder(writer: BitWriter, linear: number[], algorithm: McoImageV3BlockAlgorithmId, palette: number[], options: EncodeOptions) {
  if(!linear.length)throw new MCOImageV3InvalidInputError('Empty shared block');
  const map=localIndexMap(palette), bits=localBits(palette.length);
  const pixels=linear.map(c=>{const i=map.get(c);if(i==null)throw new MCOImageV3InvalidInputError('Shared palette missing color');return i;});
  const rowLength=options.rowLength as number,bg=options.backgroundColor as number;
  switch(algorithm){
    case MCOImageV3BlockAlgorithm.rawLocal: for(const p of pixels)writer.writeBits(p,bits);return;
    case MCOImageV3BlockAlgorithm.compactRle:{let consumed=0;for(const run of buildRuns(pixels)){writer.writeBits(run.color,bits);writer.writeBoundedCompactUint(run.length-1,pixels.length-consumed-1);consumed+=run.length;}return;}
    case MCOImageV3BlockAlgorithm.varUintRle:for(const run of buildRuns(pixels)){writer.writeBits(run.color,bits);writer.writeBitVarUint(run.length);}return;
    case MCOImageV3BlockAlgorithm.lzPixels:{const greedy=buildGreedyLzTokens(pixels,bits);let tokens=greedy;if(!options.greedyLzOnly&&pixels.length<=1024){const optimal=buildOptimalLzTokens(pixels,bits);if(optimal&&lzTokensBitCost(optimal,bits,pixels.length)<lzTokensBitCost(greedy,bits,pixels.length))tokens=optimal;}writeLzTokens(writer,tokens,bits,pixels.length);return;}
    case MCOImageV3BlockAlgorithm.quadtree:if(rowLength<=0||linear.length%rowLength!==0)throw new MCOImageV3InvalidInputError('Invalid quadtree');writeQuadtreeNodeEncoder(writer,pixels,rowLength,0,0,rowLength,linear.length/rowLength,bits);return;
    case MCOImageV3BlockAlgorithm.bitplanes:writeLegacyBitplanesBody(writer,pixels,bits);return;
    case MCOImageV3BlockAlgorithm.adaptiveBitplanes:writeAdaptiveBitplanesBody(writer,pixels,bits);return;
    case MCOImageV3BlockAlgorithm.rowDelta:writeRowDeltaBodyEncoder(writer,pixels,rowLength,bits);return;
    case MCOImageV3BlockAlgorithm.compactRowDelta:writeCompactRowDeltaBodyEncoder(writer,pixels,rowLength,bits,false);return;
    case MCOImageV3BlockAlgorithm.rowRepeat:writeRowRepeatEncoder(writer,pixels,rowLength,bits);return;
    case MCOImageV3BlockAlgorithm.biColorMask:{const fg=biColorForeground(linear,bg);if(fg==null)throw new MCOImageV3InvalidInputError('Not bi-color');writer.writeBits(map.get(fg)!,bits);for(const c of linear)writer.writeBits(c===fg?1:0,1);return;}
    case MCOImageV3BlockAlgorithm.compactSparse:
    case MCOImageV3BlockAlgorithm.varUintSparse:{const analysis=sparseAnalysis(linear,bg);if(!analysis.segments.length)throw new MCOImageV3InvalidInputError('Empty sparse');if(algorithm===MCOImageV3BlockAlgorithm.varUintSparse)writer.writeBitVarUint(analysis.segments.length);else writer.writeBoundedCompactUint(analysis.segments.length-1,linear.length-1);let pos=0;for(const segment of analysis.segments){const index=map.get(segment.color);if(index==null)throw new MCOImageV3InvalidInputError('Shared palette missing sparse color');if(algorithm===MCOImageV3BlockAlgorithm.varUintSparse){writer.writeBitVarUint(segment.start-pos);writer.writeBits(index,bits);writer.writeBitVarUint(segment.length);}else{writer.writeBoundedCompactUint(segment.start-pos,linear.length-pos-1);writer.writeBits(index,bits);writer.writeBoundedCompactUint(segment.length-1,linear.length-segment.start-1);}pos=segment.start+segment.length;}return;}
    default:throw new MCOImageV3InvalidInputError('Unsupported shared algorithm');
  }
}

export function regionScansEncoder(high: boolean) {
  return high ? [ScanMode.h, ScanMode.v, ScanMode.s, ScanMode.sv] : [ScanMode.h, ScanMode.v, ScanMode.s];
}

export function regionAlgorithmsEncoder(high: boolean, sharedPalette: boolean) {
  if (sharedPalette) return high ? FULL_SHARED_REGION_ALGORITHMS : NORMAL_SHARED_REGION_ALGORITHMS;
  return high ? FULL_REGION_BLOCK_ALGORITHMS : NORMAL_REGION_BLOCK_ALGORITHMS;
}

export function localPaletteOrderAffectsBodyEncoder(algorithm: McoImageV3BlockAlgorithmId) {
  return algorithm === MCOImageV3BlockAlgorithm.bitplanes ||
    algorithm === MCOImageV3BlockAlgorithm.adaptiveBitplanes ||
    algorithm === MCOImageV3BlockAlgorithm.compactRowDelta ||
    algorithm === MCOImageV3BlockAlgorithm.rowDelta;
}

export function regionBlockTieRankEncoder(block: RegionBodyResult) {
  return modeTieRank(imageModeForAlgorithm(block.algorithm));
}

export function isBetterRegionBlockEncoder(candidate: RegionBlock, best: RegionBlock | null) {
  if (!best) return true;
  if (candidate.cost !== best.cost) return candidate.cost < best.cost;
  return regionBlockTieRankEncoder(candidate) < regionBlockTieRankEncoder(best);
}

export function paletteBitLengthEncoder(profile: number, palette: number[]) {
  const writer = new BitWriter();
  writeLocalPalette(writer, profile, palette);
  return writer.bitLength;
}

export function sharedPaletteVariantSetsEncoder(image: V3Image, prepared: PreparedRegion[], backgroundColor: number, high: boolean): SharedPaletteVariants {
  const allPixels = prepared.flatMap((region) => region.pixels);
  return {
    invariant: localPaletteVariants(allPixels, image.paletteProfile, {
      indexOrderSensitive: false,
      includeTransitionOrder: false,
    }),
    sensitive: localPaletteVariants(allPixels, image.paletteProfile, {
      indexOrderSensitive: true,
      includeTransitionOrder: high,
      includeBitplaneOptimizedOrder: high,
      includeRgbOrder: high,
      preferredFirstColor: backgroundColor,
    }),
  };
}

export function bestRegionBlockEncoder(image: V3Image, region: PreparedRegion, backgroundColor: number, high: boolean, sharedPalette: number[] | null): RegionBlock | null {
  let best: RegionBlock | null = null;
  for (const scan of regionScansEncoder(high)) {
    for (const algorithm of regionAlgorithmsEncoder(high, sharedPalette != null)) {
      const body = tryRegionBodyEncoder(
        image, region.pixels, region.bounds, algorithm, scan, backgroundColor, high, sharedPalette,
      );
      if (!body) continue;
      const candidate = { ...body, cost: regionHeaderBitCost(algorithm) + body.bitLength };
      if (isBetterRegionBlockEncoder(candidate, best)) best = candidate;
    }
  }
  return best;
}

export function bestIndividualRegionBlocksEncoder(image: V3Image, prepared: PreparedRegion[], backgroundColor: number, high: boolean, sharedPalette: number[] | null): RegionBlock[] | null {
  const blocks: RegionBlock[] = [];
  for (const region of prepared) {
    const block = bestRegionBlockEncoder(image, region, backgroundColor, high, sharedPalette);
    if (!block) return null;
    blocks.push(block);
  }
  return blocks;
}

export function bestCommonRegionPlanEncoder(image: V3Image, prepared: PreparedRegion[], backgroundColor: number, high: boolean, sharedPalette: number[] | null) {
  if (sharedPalette && prepared.length < 3) return null;
  let best: RegionPlan | null = null;
  for (const scan of regionScansEncoder(high)) {
    for (const algorithm of regionAlgorithmsEncoder(high, sharedPalette != null)) {
      const bodies: RegionBodyResult[] = [];
      let cost = regionHeaderBitCost(algorithm), failed = false;
      for (const region of prepared) {
        const body = tryRegionBodyEncoder(
          image, region.pixels, region.bounds, algorithm, scan, backgroundColor, high, sharedPalette,
        );
        if (!body) { failed = true; break; }
        bodies.push(body); cost += body.bitLength;
      }
      if (failed) continue;
      const candidate = { algorithm, scan, blocks: bodies, cost, sharedPalette };
      if (!best || cost < best.cost ||
          (cost === best.cost && modeTieRank(imageModeForAlgorithm(algorithm)) <
            modeTieRank(imageModeForAlgorithm(best.algorithm as McoImageV3BlockAlgorithmId)))) best = candidate;
    }
  }
  return best;
}

export function bestHybridRegionPlanEncoder(image: V3Image, prepared: PreparedRegion[], backgroundColor: number, high: boolean, sharedPalette: number[] | null, individualBlocks: RegionBlock[] | null) {
  if (!sharedPalette && prepared.length < 3) return null;
  if (!individualBlocks) return null;
  let best: RegionPlan | null = null;
  for (const scan of regionScansEncoder(high)) {
    for (const algorithm of regionAlgorithmsEncoder(high, sharedPalette != null)) {
      const blocks: RegionBodyResult[] = [], usesCommon: boolean[] = [];
      let cost = 5 + regionHeaderBitCost(algorithm), commonCount = 0, exceptionCount = 0;
      for (let index = 0; index < prepared.length; index++) {
        const commonBlock = tryRegionBodyEncoder(
          image, prepared[index].pixels, prepared[index].bounds,
          algorithm, scan, backgroundColor, high, sharedPalette,
        );
        const individual = individualBlocks[index];
        const commonBits = commonBlock == null ? Infinity : 1 + commonBlock.bitLength;
        const exceptionBits = 1 + individual.cost;
        if (commonBlock && commonBits <= exceptionBits) {
          blocks.push(commonBlock); usesCommon.push(true); cost += commonBits; commonCount++;
        } else {
          blocks.push(individual); usesCommon.push(false); cost += exceptionBits; exceptionCount++;
        }
      }
      if (commonCount === 0 || exceptionCount === 0) continue;
      const candidate = { algorithm, scan, blocks, usesCommon, cost, sharedPalette };
      if (!best || cost < best.cost ||
          (cost === best.cost && modeTieRank(imageModeForAlgorithm(algorithm)) <
            modeTieRank(imageModeForAlgorithm(best.algorithm as McoImageV3BlockAlgorithmId)))) best = candidate;
    }
  }
  return best;
}

export function bestSharedIndividualPlanEncoder(image: V3Image, prepared: PreparedRegion[], backgroundColor: number, high: boolean, variants: SharedPaletteVariants) {
  let best: RegionPlan | null = null;
  for (const palette of variants.sensitive) {
    const blocks = bestIndividualRegionBlocksEncoder(image, prepared, backgroundColor, high, palette);
    if (!blocks) continue;
    const cost = paletteBitLengthEncoder(image.paletteProfile, palette) +
      blocks.reduce((sum, block) => sum + block.cost, 0);
    if (!best || cost < best.cost) best = { blocks, cost, sharedPalette: palette };
  }
  return best;
}

export function bestSharedCommonPlanEncoder(image: V3Image, prepared: PreparedRegion[], backgroundColor: number, high: boolean, variants: SharedPaletteVariants) {
  if (prepared.length < 3) return null;
  let best: RegionPlan | null = null;
  for (const scan of regionScansEncoder(high)) {
    for (const algorithm of regionAlgorithmsEncoder(high, true)) {
      const palettes = localPaletteOrderAffectsBodyEncoder(algorithm)
        ? variants.sensitive : variants.invariant;
      for (const palette of palettes) {
        const bodies: RegionBodyResult[] = [];
        let cost = paletteBitLengthEncoder(image.paletteProfile, palette) + regionHeaderBitCost(algorithm);
        let failed = false;
        for (const region of prepared) {
          const body = tryRegionBodyEncoder(
            image, region.pixels, region.bounds, algorithm, scan, backgroundColor, high, palette,
          );
          if (!body) { failed = true; break; }
          bodies.push(body); cost += body.bitLength;
        }
        if (failed) continue;
        const candidate = {
          algorithm, scan, blocks: bodies, cost, sharedPalette: palette,
        };
        if (!best || cost < best.cost ||
            (cost === best.cost && modeTieRank(imageModeForAlgorithm(algorithm)) <
              modeTieRank(imageModeForAlgorithm(best.algorithm as McoImageV3BlockAlgorithmId)))) best = candidate;
      }
    }
  }
  return best;
}

export function bestSharedHybridPlanEncoder(image: V3Image, prepared: PreparedRegion[], backgroundColor: number, high: boolean, variants: SharedPaletteVariants) {
  let best: RegionPlan | null = null;
  for (const palette of variants.sensitive) {
    const individualBlocks = bestIndividualRegionBlocksEncoder(
      image, prepared, backgroundColor, high, palette,
    );
    if (!individualBlocks) continue;
    const paletteBits = paletteBitLengthEncoder(image.paletteProfile, palette);
    for (const scan of regionScansEncoder(high)) {
      for (const algorithm of regionAlgorithmsEncoder(high, true)) {
        const blocks: RegionBodyResult[] = [], usesCommon: boolean[] = [];
        let cost = paletteBits + 5 + regionHeaderBitCost(algorithm);
        let commonCount = 0, exceptionCount = 0;
        for (let index = 0; index < prepared.length; index++) {
          const commonBlock = tryRegionBodyEncoder(
            image, prepared[index].pixels, prepared[index].bounds,
            algorithm, scan, backgroundColor, high, palette,
          );
          const individual = individualBlocks[index];
          const commonBits = commonBlock == null ? Infinity : 1 + commonBlock.bitLength;
          const exceptionBits = 1 + individual.cost;
          if (commonBlock && commonBits <= exceptionBits) {
            blocks.push(commonBlock); usesCommon.push(true); cost += commonBits; commonCount++;
          } else {
            blocks.push(individual); usesCommon.push(false); cost += exceptionBits; exceptionCount++;
          }
        }
        if (commonCount === 0 || exceptionCount === 0) continue;
        const candidate = {
          algorithm, scan, blocks, usesCommon, cost, sharedPalette: palette,
        };
        if (!best || cost < best.cost ||
            (cost === best.cost && modeTieRank(imageModeForAlgorithm(algorithm)) <
              modeTieRank(imageModeForAlgorithm(best.algorithm as McoImageV3BlockAlgorithmId)))) best = candidate;
      }
    }
  }
  return best;
}


export function regionPlanCacheKeyEncoder(backgroundColor: number, high: boolean, regions: Bounds[]) {
  return `${backgroundColor}|${high ? 1 : 0}|${regionListKeyEncoder(regions)}`;
}

export function regionPlanCacheEncoder(image: V3Image, backgroundColor: number, regions: Bounds[], high: boolean) {
  const key = regionPlanCacheKeyEncoder(backgroundColor, high, regions);
  if (caches.regionPlan != null && caches.regionPlan!.has(key)) {
    return caches.regionPlan!.get(key)!;
  }
  const cache: RegionPlanCache = {
    prepared: regions.map((bounds) => ({ bounds, pixels: extractRegionPixelsEncoder(image, bounds) })),
    sharedVariants: null,
    individual: undefined,
    common: undefined,
    hybrid: undefined,
    sharedIndividual: undefined,
    sharedCommon: undefined,
    sharedHybrid: undefined,
  };
  if (caches.regionPlan != null) caches.regionPlan!.set(key, cache);
  return cache;
}

export function regionPlanForOptionsEncoder(image: V3Image, backgroundColor: number, high: boolean, cache: RegionPlanCache, options: EncodeOptions): RegionPlan | null | undefined {
  if (options.sharedLocalPalette) {
    cache.sharedVariants ??= sharedPaletteVariantSetsEncoder(
      image, cache.prepared, backgroundColor, high,
    );
    if (options.hybridCommonHeader) {
      if (cache.sharedHybrid === undefined) {
        cache.sharedHybrid = bestSharedHybridPlanEncoder(
          image, cache.prepared, backgroundColor, high, cache.sharedVariants,
        );
      }
      return cache.sharedHybrid;
    }
    if (options.commonBlockHeader) {
      if (cache.sharedCommon === undefined) {
        cache.sharedCommon = bestSharedCommonPlanEncoder(
          image, cache.prepared, backgroundColor, high, cache.sharedVariants,
        );
      }
      return cache.sharedCommon;
    }
    if (cache.sharedIndividual === undefined) {
      cache.sharedIndividual = bestSharedIndividualPlanEncoder(
        image, cache.prepared, backgroundColor, high, cache.sharedVariants,
      );
    }
    return cache.sharedIndividual;
  }

  if (cache.individual === undefined) {
    const blocks = bestIndividualRegionBlocksEncoder(
      image, cache.prepared, backgroundColor, high, null,
    );
    cache.individual = blocks == null ? null : {
      blocks,
      cost: blocks.reduce((sum, block) => sum + block.cost, 0),
      sharedPalette: null,
    };
  }
  if (options.hybridCommonHeader) {
    if (cache.hybrid === undefined) {
      cache.hybrid = cache.individual == null ? null : bestHybridRegionPlanEncoder(
        image, cache.prepared, backgroundColor, high, null, cache.individual.blocks as RegionBlock[],
      );
    }
    return cache.hybrid;
  }
  if (options.commonBlockHeader) {
    if (cache.common === undefined) {
      cache.common = bestCommonRegionPlanEncoder(
        image, cache.prepared, backgroundColor, high, null,
      );
    }
    return cache.common;
  }
  return cache.individual;
}

export function writeRegionHeaderEncoder(writer: BitWriter, algorithm: McoImageV3BlockAlgorithmId, scan: ScanModeId) {
  writer.writeBits(algorithm,5);
  if(!canUseCompactBlockHeader(algorithm))writer.writeBits(scan,2);
}

export function tryBuildRegionsCandidateEncoder(image: V3Image, backgroundColor: number, backgroundRank: number, regions: Bounds[], options: EncodeOptions, high: boolean, planCacheOverride: RegionPlanCache | null = null) {
  const maxRegions = high ? MAX_REGIONS : NORMAL_MAX_REGIONS;
  if(regions.length < 2 || regions.length > maxRegions || !regionsDoNotOverlapEncoder(regions)) return null;
  if (options.commonBlockHeader && !options.compactGeometry) return null;
  if (options.hybridCommonHeader && !options.commonBlockHeader) return null;
  if (options.deltaGeometry && !options.compactGeometry) return null;
  if (options.sharedLocalPalette && !options.compactGeometry) return null;

  const planCache = planCacheOverride || regionPlanCacheEncoder(image, backgroundColor, regions, high);
  const prepared = planCache.prepared;
  const plan = regionPlanForOptionsEncoder(
    image, backgroundColor, high, planCache, options,
  );
  if (!plan || !plan.blocks) return null;

  const sharedPalette = plan.sharedPalette || null;
  const implicit=isImplicitWhiteBackground(image.paletteProfile,backgroundColor);
  const container=options.compactGeometry?MCOImageV3Container.compactRegionsStream:MCOImageV3Container.regions;
  const writer=new BitWriter();
  writeImagePreamble(writer,image,ScanMode.h,implicit,container,regions.length-1);
  if(image.transparentColor!=null)writeColorRef(writer,image.paletteProfile,image.transparentColor);
  writeBackgroundRef(writer,image.paletteProfile,backgroundColor,implicit);
  if(options.compactGeometry){
    writer.writeBits(options.commonBlockHeader?1:0,1);
    writer.writeBits(options.deltaGeometry?1:0,1);
    writer.writeBits(sharedPalette?1:0,1);
    if(options.commonBlockHeader){
      if(options.hybridCommonHeader){
        writer.writeBits(HYBRID_COMMON_REGION_ALGORITHM_MARKER,5);
        writer.writeBits(plan.algorithm as McoImageV3BlockAlgorithmId,5);
      } else writer.writeBits(plan.algorithm as McoImageV3BlockAlgorithmId,5);
      if(!canUseCompactBlockHeader(plan.algorithm as McoImageV3BlockAlgorithmId))writer.writeBits(plan.scan as ScanModeId,2);
    }
    if(sharedPalette)writeLocalPalette(writer,image.paletteProfile,sharedPalette);
  }
  let previous: Bounds | null=null;
  for(let index=0;index<prepared.length;index++){
    const region=prepared[index];
    if(options.deltaGeometry&&index>0)writeDeltaRegionGeometry(writer,region.bounds,previous as Bounds);
    else writeRegionGeometry(writer,region.bounds,image.width,image.height,options.compactGeometry as boolean);
    previous=region.bounds;
    const block=plan.blocks[index];
    if(options.hybridCommonHeader){
      const usesCommon=(plan.usesCommon as boolean[])[index];
      writer.writeBits(usesCommon?0:1,1);
      if(!usesCommon)writeRegionHeaderEncoder(writer,block.algorithm,block.scan);
    } else if(!options.commonBlockHeader) writeRegionHeaderEncoder(writer,block.algorithm,block.scan);
    writer.writeBitStream(block.bytes,block.bitLength);
  }
  return makeCandidate(writer.toBytes(),{
    mode:ImageMode.regionsBg,scan:ScanMode.h,backgroundColor,backgroundRank,
    transparentColor:image.transparentColor,regionCount:regions.length,
    localPaletteSize:sharedPalette?sharedPalette.length:null,
    bitsPerLocalPixel:sharedPalette?localBits(sharedPalette.length):null,
    paletteKind:isDynamicProfile(image.paletteProfile)?'dynamic':'fixed',
    container:MCOImageV3ContainerName[container],
  });
}


export function regionLayoutByteCostEncoder(image: V3Image, backgroundColor: number, regions: Bounds[], high: boolean, sharedOnly: boolean) {
  const key = caches.regionLayoutCost == null ? null : [
    backgroundColor, high ? 1 : 0, sharedOnly ? 1 : 0, regionListKeyEncoder(regions),
  ].join('|');
  if (key != null && caches.regionLayoutCost!.has(key)) return caches.regionLayoutCost!.get(key) as number | null;
  let best = null;
  if (!sharedOnly) {
    const nonCompact = tryBuildRegionsCandidateEncoder(image, backgroundColor, 0, regions, {
      compactGeometry:false, commonBlockHeader:false, hybridCommonHeader:false,
      deltaGeometry:false, sharedLocalPalette:false,
    }, high);
    if (nonCompact) best = nonCompact.byteLength;
  }
  const optionsList = high ? FULL_REGION_OPTIONS : NORMAL_REGION_OPTIONS;
  for (const options of optionsList) {
    if (sharedOnly && !options.sharedLocalPalette) continue;
    const candidate = tryBuildRegionsCandidateEncoder(image, backgroundColor, 0, regions, {
      compactGeometry:true, ...options,
    }, high);
    if (candidate && (best == null || candidate.byteLength < best)) best = candidate.byteLength;
  }
  if (key != null) caches.regionLayoutCost!.set(key, best);
  return best;
}
