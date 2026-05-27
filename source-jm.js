/**
 * source-jm.js - JM (禁漫) 图片源逻辑
 * 用于从 JM 漫画 CDN 加载和显示图片，包含图片解密处理
 */

(function() {
    'use strict';

    // 确保 Framework 已加载
    if (!window.Framework) {
        console.error('Framework not loaded yet, skipping JM source registration');
        return;
    }

    const F = window.Framework;

    // ========== JM 特有逻辑 ==========
    
    // 动态探测机制的状态变量
    let consecutiveFailures = 0;
    let actualTotalPages = null; // 探测到的实际总页数
    let isDetectingEnd = true; // 是否正在探测结束位置
    let lastSuccessfulPage = 0; // 最后成功加载的页码
    
    // 检查图片 URL 是否有效
    async function checkImageUrl(url) {
        try {
            const response = await fetch(url, { method: 'HEAD' });
            return response.ok;
        } catch (error) {
            return false;
        }
    }

    // 计算列数（用于图片解密）
    function getCols(aid, pageNum) {
        const e = String(aid).trim();
        const t = String(pageNum).padStart(5, '0');
        const hash = md5(e + t);
        const asciiVal = hash.charCodeAt(hash.length - 1);
        const eInt = parseInt(e, 10);
        
        let n = asciiVal;
        if (eInt >= 268850 && eInt <= 421925) n %= 10;
        else if (eInt >= 421926) n %= 8;
        else n %= 10;
        
        return 2 + n * 2;
    }

    // 处理图片（解密/重排）
    function processImage(imgElement, index) {
        if (!imgElement || !imgElement.parentNode) {
            console.debug("页 " + index + " 的图片未挂载到 DOM 或已被移除，跳过处理。");
            return false;
        }
        
        var canvas = document.createElement("canvas");
        canvas.className = "display-image";
        
        var ctx = canvas.getContext("2d", { willReadFrequently: true });
        var naturalWidth = imgElement.naturalWidth, naturalHeight = imgElement.naturalHeight;
        
        if (!naturalWidth || !naturalHeight) {
            console.error("页 " + index + " 的图片尺寸无效：" + naturalWidth + "x" + naturalHeight);
            return false;
        }
        
        canvas.width = naturalWidth;
        canvas.height = naturalHeight;
        var container = imgElement.parentNode;
        
        if (!container.id || !container.id.startsWith("page-")) {
            console.debug("页 " + index + " 的图片在处理过程中被移除，跳过处理。");
            return false;
        }
        
        var pageId = container.id.replace("page-", "");
        var sliceCount = getCols(F.state.id, pageId);
        var baseH = Math.floor(naturalHeight / sliceCount);
        var remainder = naturalHeight % sliceCount;
        
        // 核心重绘：原图从下往上切片 -> Canvas 从上往下顺序拼接
        for (var i = 0; i < sliceCount; i++) {
            var srcIdx = sliceCount - 1 - i; // 倒序索引
            var srcH = baseH + (srcIdx === 0 ? remainder : 0);
            var srcY = srcIdx === 0 ? 0 : baseH * srcIdx + remainder;
            var destH = baseH + (i === 0 ? remainder : 0);
            var destY = i === 0 ? 0 : baseH * i + remainder;
            
            ctx.drawImage(imgElement, 0, srcY, naturalWidth, srcH, 0, destY, naturalWidth, destH);
        }
        
        imgElement.after(canvas);
        imgElement.classList.add("source-image");
        
        return true;
    }

    // 发现所有可用的图片（通过探测 URL 存在性）- 仅用于初始化时获取第一张图片的 URL
    // 懒加载机制改为边滚动边探测，而不是预先发现所有图片
    async function discoverFirstImage(mangaId) {
        const indexStr = String(1).padStart(5, '0');
        const cdnDomain = 'https://cdn-msp.jm18c-uoe.cc';
        const imgUrl = `${cdnDomain}/media/photos/${mangaId}/${indexStr}.webp`;
        
        const exists = await checkImageUrl(imgUrl);
        if (exists) {
            return [{ index: 1, url: imgUrl }];
        }
        return [];
    }

    // 构建图片 URL
    function buildImageUrl(mangaId, pageNum) {
        const indexStr = String(pageNum).padStart(5, '0');
        const cdnDomain = 'https://cdn-msp.jm18c-uoe.cc';
        return `${cdnDomain}/media/photos/${mangaId}/${indexStr}.webp`;
    }

    // 重置动态探测机制的状态
    function resetDetectionState() {
        consecutiveFailures = 0;
        actualTotalPages = null;
        isDetectingEnd = true;
        lastSuccessfulPage = 0;
    }

    // 在图片加载成功时重置连续失败计数器
    function resetFailureCounter(successfulPageIndex) {
        if (isDetectingEnd) {
            consecutiveFailures = 0;
            // 更新最后成功加载的页码（只增不减）
            if (successfulPageIndex > lastSuccessfulPage) {
                lastSuccessfulPage = successfulPageIndex;
            }
            console.log(`页 ${successfulPageIndex} 加载成功，连续失败计数重置为 0，最后成功页码：${lastSuccessfulPage}`);
        }
    }

    // 移除不存在的页面元素
    function removeNonExistentPages(actualPages) {
        const container = document.getElementById('contentContainer');
        for (let i = actualPages + 1; i <= F.CONFIG.MAX_PAGES; i++) {
            const pageEl = document.getElementById(`page-${i}`);
            if (pageEl) {
                pageEl.remove();
            }
        }
    }

    // 创建页面元素
    function createPageElement(index) {
        const container = document.createElement("div");
        container.id = `page-${index}`;
        container.className = "page-wrapper";
        
        const img = document.createElement("img");
        img.id = `img-${index}`;
        img.className = "manga-page source-image";
        img.alt = `第 ${index} 页`;
        img.crossOrigin = "anonymous";
        
        container.appendChild(img);
        return container;
    }

    // 加载单页图片
    function loadPage(index, retryCount = 0) {
        const container = document.getElementById(`page-${index}`);
        if (!container) return;
        
        const img = container.querySelector('img');
        if (!img) return;
        
        if (container.classList.contains('loaded') || img.getAttribute('data-loading') === 'true') {
            return;
        }
        
        img.setAttribute('data-loading', 'true');
        F.showLoading(container);
        const maxRetries = 3;
        
        // 动态构建图片 URL
        const imgUrl = buildImageUrl(F.state.id, index);
        
        // 确保图片元素已挂载到 DOM
        if (!img.isConnected) {
            console.error(`页 ${index} 的图片未挂载到 DOM，重新添加到容器`);
            container.innerHTML = '';
            container.appendChild(img);
        }
        
        img.onload = function() {
            try {
                // 清除 loading 状态（此时 img 已加载完成，但 canvas 还未创建）
                F.clearLoadingState(container);
                
                var success = processImage(img, index);
                if (success) {
                    container.classList.add('loaded');
                    F.state.loadedCount++;
                    resetFailureCounter(index); // 重置连续失败计数器
                    F.updatePageInfo();
                    // 图片加载完成后触发继续加载
                    loadPagesAroundCurrentPage();
                } else {
                    console.warn(`页 ${index}: 图片处理失败，将重试`);
                    throw new Error('图片处理返回失败');
                }
                
                img.removeAttribute('data-loading');
            } catch (e) {
                console.error(`处理图片失败 (页 ${index}):`, e);
                img.removeAttribute('data-loading');
                if (retryCount < maxRetries) {
                    setTimeout(() => loadPage(index, retryCount + 1), 1000 * (retryCount + 1));
                } else {
                    F.showError(container, () => loadPage(index, 0));
                }
            }
        };
        
        img.onerror = function(e) {
            console.warn(`加载图片失败 (页 ${index}), 重试次数：${retryCount}, 错误事件:`, e);
            img.removeAttribute('data-loading');
            
            // 动态探测机制：记录连续失败（只在顺序探测时有效）
            if (isDetectingEnd && retryCount >= maxRetries) {
                // 只有当失败的页码是紧接着最后成功页码的下一页时，才计入连续失败
                if (index === lastSuccessfulPage + consecutiveFailures + 1) {
                    consecutiveFailures++;
                    console.log(`页 ${index} 加载失败，连续失败次数：${consecutiveFailures}，最后成功页码：${lastSuccessfulPage}`);
                    
                    // 如果连续 3 次失败，认为已经获取到全部图片
                    if (consecutiveFailures >= 3 && actualTotalPages === null) {
                        actualTotalPages = lastSuccessfulPage; // 最后成功加载的页是最后一页
                        F.state.totalPages = actualTotalPages;
                        isDetectingEnd = false;
                        console.log(`探测完成：实际总页数为 ${actualTotalPages}`);
                        F.updatePageInfo();
                        F.showToast(`漫画共 ${actualTotalPages} 页`);
                        
                        // 移除后续不存在的页面元素
                        removeNonExistentPages(actualTotalPages);
                    }
                } else {
                    console.log(`页 ${index} 不是顺序探测的目标页（期望页码：${lastSuccessfulPage + consecutiveFailures + 1}），不计入连续失败`);
                }
            }
            
            if (retryCount < maxRetries) {
                setTimeout(() => loadPage(index, retryCount + 1), 1000 * (retryCount + 1));
            } else {
                F.showError(container, () => loadPage(index, 0));
            }
        };
        
        img.src = imgUrl;
    }

    // 并发加载多页 - 修改为懒加载模式：只加载前几页，其余边滚动边加载
    function loadPagesConcurrently(startIndex, count) {
        // 初始只加载前几页用于显示，而不是等待所有图片发现完成
        const initialLoadCount = Math.min(count, F.CONFIG.CONCURRENT_LOAD);
        for (let i = startIndex; i <= startIndex + initialLoadCount - 1 && i <= F.CONFIG.MAX_PAGES; i++) {
            loadPage(i);
        }
    }

    // 滚动时加载当前页面附近的图片
    function loadPagesAroundCurrentPage() {
        if (!isDetectingEnd) {
            // 已经完成探测，按正常逻辑加载可见页面附近的图片
            const visiblePages = F.getVisiblePages();
            if (visiblePages.length === 0) return;
            const currentPage = Math.min(...visiblePages);
            
            for (let i = currentPage; i < currentPage + F.CONFIG.BATCH_SIZE && i <= F.state.totalPages; i++) {
                const container = document.getElementById(`page-${i}`);
                if (!container) continue;
                const img = container.querySelector('img');
                if (!container.classList.contains('loaded') && !container.querySelector('canvas') && img && img.getAttribute('data-loading') !== 'true') {
                    loadPage(i);
                }
            }
            return;
        }
        
        // 动态探测机制：只加载顺序的下一页，用于探测是否还有更多图片
        const nextPageToProbe = lastSuccessfulPage + 1;
        let probePageIsLoadingOrLoaded = false;
        
        if (nextPageToProbe <= F.CONFIG.MAX_PAGES) {
            const container = document.getElementById(`page-${nextPageToProbe}`);
            if (container) {
                const img = container.querySelector('img');
                // 检查探测页是否已经在加载中或已处理
                if (container.classList.contains('loaded') || container.querySelector('canvas') || (img && img.getAttribute('data-loading') === 'true')) {
                    probePageIsLoadingOrLoaded = true;
                } else {
                    // 探测页还未加载，触发加载
                    loadPage(nextPageToProbe);
                    return; // 先加载探测页，等待结果
                }
            } else {
                // 容器不存在，创建它
                const contentContainer = document.getElementById('contentContainer');
                contentContainer.appendChild(createPageElement(nextPageToProbe));
                loadPage(nextPageToProbe);
                return;
            }
        }
        
        // 如果探测页已经在加载中或已加载完成，说明当前页附近的图片已经加载完成
        // 开始向下依次继续加载剩余所有图片
        if (probePageIsLoadingOrLoaded) {
            let nextUnloadedPage = lastSuccessfulPage + 1;
            while (nextUnloadedPage <= F.CONFIG.MAX_PAGES) {
                const container = document.getElementById(`page-${nextUnloadedPage}`);
                if (!container) {
                    // 容器不存在，创建它
                    const contentContainer = document.getElementById('contentContainer');
                    contentContainer.appendChild(createPageElement(nextUnloadedPage));
                }
                const img = container ? container.querySelector('img') : null;
                // 跳过已加载、加载中或已处理的页面
                if (container && !container.classList.contains('loaded') && !container.querySelector('canvas') && img && img.getAttribute('data-loading') !== 'true') {
                    loadPage(nextUnloadedPage);
                    // 并发加载，每次最多 CONCURRENT_LOAD 个
                    if ((nextUnloadedPage - lastSuccessfulPage) % F.CONFIG.CONCURRENT_LOAD === 0) {
                        break; // 等待下一批
                    }
                }
                nextUnloadedPage++;
            }
        }
    }

    // 主动加载并处理单页图片（用于下载）
    async function loadAndProcessPage(pageNum) {
        return new Promise((resolve, reject) => {
            // 动态构建图片 URL
            const imgUrl = buildImageUrl(F.state.id, pageNum);
            
            const img = new Image();
            img.crossOrigin = 'anonymous';
            
            img.onload = function() {
                try {
                    var canvas = document.createElement("canvas");
                    canvas.className = "display-image";
                    
                    var ctx = canvas.getContext("2d", { willReadFrequently: true });
                    var naturalWidth = img.naturalWidth, naturalHeight = img.naturalHeight;
                    
                    if (!naturalWidth || !naturalHeight) {
                        console.error("页 " + pageNum + " 的图片尺寸无效：" + naturalWidth + "x" + naturalHeight);
                        reject(new Error('图片尺寸无效'));
                        return;
                    }
                    
                    canvas.width = naturalWidth;
                    canvas.height = naturalHeight;
                    
                    var sliceCount = getCols(F.state.id, pageNum);
                    var baseH = Math.floor(naturalHeight / sliceCount);
                    var remainder = naturalHeight % sliceCount;
                    
                    // 核心重绘：原图从下往上切片 -> Canvas 从上往下顺序拼接
                    for (var i = 0; i < sliceCount; i++) {
                        var srcIdx = sliceCount - 1 - i;
                        var srcH = baseH + (srcIdx === 0 ? remainder : 0);
                        var srcY = srcIdx === 0 ? 0 : baseH * srcIdx + remainder;
                        var destH = baseH + (i === 0 ? remainder : 0);
                        var destY = i === 0 ? 0 : baseH * i + remainder;
                        
                        ctx.drawImage(img, 0, srcY, naturalWidth, srcH, 0, destY, naturalWidth, destH);
                    }
                    
                    resolve(canvas);
                } catch (e) {
                    reject(e);
                }
            };
            
            img.onerror = function(e) {
                console.warn(`加载图片失败 (页 ${pageNum}):`, e);
                resolve(null);
            };
            
            img.src = imgUrl;
        });
    }

    // 下载当前可见的图片
    function downloadCurrent() {
        const visiblePages = F.getVisiblePages();
        if (visiblePages.length === 0) {
            F.showToast('没有可见的图片');
            return;
        }
        const currentIndex = Math.min(...visiblePages);
        const container = document.getElementById(`page-${currentIndex}`);
        const canvas = container.querySelector('canvas.display-image');
        if (!canvas) {
            F.showToast('图片尚未加载');
            return;
        }
        
        canvas.toBlob((blob) => {
            if (blob) {
                const link = document.createElement('a');
                link.href = URL.createObjectURL(blob);
                link.download = `漫画${F.state.id}_page${String(currentIndex).padStart(5, '0')}.jpg`;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                F.showToast('下载已触发');
            } else {
                F.showToast('无法生成图片');
            }
        }, 'image/jpeg', 0.9);
    }

    // 下载所有图片
    async function downloadAll() {
        F.showToast('正在下载漫画，请稍候...');
        
        try {
            const zip = new JSZip();
            const mangaName = '漫画';
            const folder = zip.folder(`${mangaName}${F.state.id}`);
            
            let downloadedCount = 0;
            let skippedCount = 0;
            
            // 使用实际探测到的图片数量，而不是固定的 MAX_PAGES
            for (let pageNum = 1; pageNum <= F.state.totalPages; pageNum++) {
                const container = document.getElementById(`page-${pageNum}`);
                
                let canvas = container ? container.querySelector('canvas.display-image') : null;
                
                if (!canvas) {
                    F.showToast(`正在处理第 ${pageNum} 页...`);
                    
                    try {
                        canvas = await loadAndProcessPage(pageNum);
                        if (!canvas) {
                            console.log(`页 ${pageNum}: 图片加载失败，跳过`);
                            skippedCount++;
                            if (skippedCount >= 3) {
                                console.log(`连续 ${skippedCount} 页加载失败，停止下载`);
                                break;
                            }
                            continue;
                        }
                    } catch (e) {
                        console.error(`页 ${pageNum}: 加载处理失败:`, e);
                        skippedCount++;
                        if (skippedCount >= 3) {
                            console.log(`连续 ${skippedCount} 页加载失败，停止下载`);
                            break;
                        }
                        continue;
                    }
                }
                
                skippedCount = 0;
                
                const blob = await new Promise((resolve, reject) => {
                    canvas.toBlob((blob) => {
                        if (blob) {
                            resolve(blob);
                        } else {
                            reject(new Error('无法生成图片'));
                        }
                    }, 'image/jpeg', 0.9);
                });
                
                const pageIdStr = String(pageNum).padStart(5, '0');
                folder.file(`${mangaName}${F.state.id}_${pageIdStr}.jpg`, blob);
                downloadedCount++;
                
                if (downloadedCount % 10 === 0) {
                    F.showToast(`正在下载漫画，已处理 ${downloadedCount} 张`);
                }
            }
            
            if (downloadedCount === 0) {
                F.showToast('暂无可下载的图片');
                return;
            }
            
            const content = await zip.generateAsync({ type: 'blob' });
            
            F.state.hasTriggeredDownload = true;
            F.state.iosZipBlob = content;
            F.state.iosZipUrl = URL.createObjectURL(content);
            
            const drawer = document.getElementById('drawer');
            const drawerOverlay = document.getElementById('drawerOverlay');
            const iosDownloadContainer = document.getElementById('iosDownloadContainer');
            
            iosDownloadContainer.classList.add('show');
            drawer.classList.add('show');
            drawerOverlay.classList.add('show');
            
            F.showToast('ZIP 已生成，请在侧边栏点击"手动下载 ZIP"按钮下载');
        } catch (error) {
            console.error('下载失败:', error);
            F.showToast('下载失败，请重试');
        }
    }

    // 初始化
    async function init() {
        const urlParams = new URLSearchParams(window.location.search);
        const mangaId = urlParams.get('id') || urlParams.get('ID') || '';
        
        if (!mangaId) {
            document.getElementById('contentTitle').textContent = '请输入漫画 ID';
            F.showToast('请在 URL 中添加 ?id=漫画 ID 参数');
            return;
        }
        
        F.state.id = mangaId;
        document.getElementById('contentTitle').textContent = `漫画 ID: ${F.state.id}`;
        
        // 重置动态探测机制的状态
        resetDetectionState();
        
        // 初始化时不预先发现所有图片，只设置一个较大的总页数上限
        // 实际页数会在加载过程中动态探测
        F.state.totalPages = F.CONFIG.MAX_PAGES;
        document.getElementById('pageInfo').textContent = `1 / ?`;

        // 创建前几页的页面元素（其余页面在滚动时动态创建）
        const container = document.getElementById('contentContainer');
        const initialPageCount = Math.min(F.CONFIG.CONCURRENT_LOAD, F.CONFIG.MAX_PAGES);
        for (let i = 1; i <= initialPageCount; i++) {
            container.appendChild(createPageElement(i));
        }

        // 开始懒加载：只加载前几页，其余边滚动边加载
        loadPagesConcurrently(1, initialPageCount);
    }

    // 注册到 Framework
    F.registerSource('JM', {
        init,
        createPageElement,
        loadPage,
        loadPagesAroundCurrentPage,
        downloadCurrent,
        downloadAll
    });
})();
