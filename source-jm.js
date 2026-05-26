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

    // 发现所有可用的图片（通过探测 URL 存在性）
    async function discoverImages(mangaId) {
        const images = [];
        
        // 使用并发请求来加速图片发现
        const batchSize = 10;
        let i = 1;
        let consecutiveNotFound = 0;
        
        while (i <= F.CONFIG.MAX_PAGES && consecutiveNotFound < 3) {
            const batchEnd = Math.min(i + batchSize - 1, F.CONFIG.MAX_PAGES);
            const batchUrls = [];
            
            for (let j = i; j <= batchEnd; j++) {
                const indexStr = String(j).padStart(5, '0');
                const cdnDomain = 'https://cdn-msp.jm18c-uoe.cc';
                const imgUrl = `${cdnDomain}/media/photos/${mangaId}/${indexStr}.webp`;
                batchUrls.push({ index: j, url: imgUrl });
            }
            
            const results = await Promise.all(
                batchUrls.map(item => 
                    checkImageUrl(item.url).then(exists => ({ ...item, exists }))
                )
            );
            
            for (const result of results) {
                if (result.exists) {
                    images.push({ url: result.url, number: result.index });
                    consecutiveNotFound = 0;
                } else {
                    consecutiveNotFound++;
                    if (consecutiveNotFound >= 3) {
                        break;
                    }
                }
            }
            
            i = batchEnd + 1;
        }
        
        return images;
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
        
        // 从已发现的图片 URL 列表中获取
        const imgUrl = F.state.imageUrls[index - 1] ? F.state.imageUrls[index - 1].url : '';
        if (!imgUrl) {
            img.removeAttribute('data-loading');
            F.showError(container, () => loadPage(index, 0));
            return;
        }
        
        // 确保图片元素已挂载到 DOM
        if (!img.isConnected) {
            console.error(`页 ${index} 的图片未挂载到 DOM，重新添加到容器`);
            container.innerHTML = '';
            container.appendChild(img);
        }
        
        img.onload = function() {
            try {
                F.clearLoadingState(container);
                
                var success = processImage(img, index);
                if (success) {
                    container.classList.add('loaded');
                    F.state.loadedCount++;
                    F.updatePageInfo();
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
            if (retryCount < maxRetries) {
                setTimeout(() => loadPage(index, retryCount + 1), 1000 * (retryCount + 1));
            } else {
                F.showError(container, () => loadPage(index, 0));
            }
        };
        
        img.src = imgUrl;
    }

    // 并发加载多页
    function loadPagesConcurrently(startIndex, count) {
        const endIndex = Math.min(startIndex + count, F.state.totalPages);
        const queue = [];
        for (let i = startIndex; i <= endIndex; i++) queue.push(i);
        
        const processQueue = async () => {
            while (queue.length > 0) {
                const batch = queue.splice(0, F.CONFIG.CONCURRENT_LOAD);
                const batchPromises = batch.map(index => new Promise(resolve => {
                    loadPage(index);
                    const checkLoaded = setInterval(() => {
                        const container = document.getElementById(`page-${index}`);
                        if (container && (container.classList.contains('loaded') || container.querySelector('.error'))) {
                            clearInterval(checkLoaded);
                            resolve();
                        }
                    }, 100);
                }));
                await Promise.all(batchPromises);
            }
        };
        processQueue();
    }

    // 主动加载并处理单页图片（用于下载）
    async function loadAndProcessPage(pageNum) {
        return new Promise((resolve, reject) => {
            // 从已发现的图片 URL 列表中获取
            const imgUrl = F.state.imageUrls[pageNum - 1] ? F.state.imageUrls[pageNum - 1].url : '';
            if (!imgUrl) {
                resolve(null);
                return;
            }
            
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
        F.showToast('正在发现图片...');
        
        // 通过探测图片存在性来计算总页数
        F.state.imageUrls = await discoverImages(mangaId);
        F.state.totalPages = F.state.imageUrls.length;
        
        if (F.state.totalPages === 0) {
            document.getElementById('contentContainer').innerHTML = '<div style="text-align:center;padding:50px;color:#666;">未找到任何图片</div>';
            document.getElementById('pageInfo').textContent = '0 / 0';
            F.showToast('未找到图片');
            return;
        }
        
        document.getElementById('pageInfo').textContent = `1 / ${F.state.totalPages}`;
        
        // 创建页面元素
        const container = document.getElementById('contentContainer');
        for (let i = 1; i <= F.state.totalPages; i++) {
            container.appendChild(createPageElement(i));
        }
        
        loadPagesConcurrently(1, Math.min(F.CONFIG.CONCURRENT_LOAD, F.state.totalPages));
    }

    // 注册到 Framework
    F.registerSource('JM', {
        init,
        createPageElement,
        loadPage,
        downloadCurrent,
        downloadAll
    });
})();
