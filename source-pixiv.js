/**
 * source-pixiv.js - Pixiv 图片源逻辑
 * 用于从 pixiv.re 加载和显示图片
 */

(function() {
    'use strict';

    // 确保 Framework 已加载
    if (!window.Framework) {
        console.error('Framework not loaded yet, skipping pixiv source registration');
        return;
    }

    const F = window.Framework;

    // ========== Pixiv 特有逻辑 ==========
    
    // 检查图片 URL 是否有效
    async function checkImageUrl(url) {
        try {
            const response = await fetch(url, { method: 'HEAD' });
            return response.ok;
        } catch (error) {
            return false;
        }
    }

    // 发现所有可用的图片
    async function discoverImages(pid) {
        const images = [];
        
        // 首先尝试没有数字的情况
        const baseUrl = `https://pixiv.re/${pid}.jpg`;
        if (await checkImageUrl(baseUrl)) {
            images.push({ url: baseUrl, number: '' });
        }
        
        // 使用并发请求来加速图片发现
        const batchSize = 10;
        let i = 1;
        let consecutiveNotFound = 0;
        
        while (i <= F.CONFIG.MAX_PAGES && consecutiveNotFound < 3) {
            const batchEnd = Math.min(i + batchSize - 1, F.CONFIG.MAX_PAGES);
            const batchUrls = [];
            
            for (let j = i; j <= batchEnd; j++) {
                batchUrls.push({ index: j, url: `https://pixiv.re/${pid}-${j}.jpg` });
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
        img.className = "display-image";
        img.alt = `第 ${index} 张`;
        img.crossOrigin = "anonymous";
        
        container.appendChild(img);
        return container;
    }

    // 加载单张图片
    function loadPage(index, retryCount = 0) {
        const container = document.getElementById(`page-${index}`);
        if (!container) return;

        // 重试时，移除之前的错误提示
        if (retryCount === 0) {
            const errorEl = container.querySelector('.error');
            if (errorEl) errorEl.remove();
            const canvasEl = container.querySelector('canvas');
            if (canvasEl) canvasEl.remove();
            const processedImg = container.querySelector('.source-image');
            if (processedImg) {
                processedImg.classList.remove('source-image');
            }
        }

        const img = container.querySelector('img');
        if (!img) return;
        
        if (container.classList.contains('loaded') && retryCount === 0) {
            return;
        }
        
        img.setAttribute('data-loading', 'true');
        F.showLoading(container);
        const maxRetries = 3;

        const imgUrl = F.state.imageUrls[index - 1] ? F.state.imageUrls[index - 1].url : '';
        if (!imgUrl) {
            img.removeAttribute('data-loading');
            F.showError(container, () => loadPage(index, 0));
            return;
        }

        if (!img.isConnected) {
            console.error(`图片 ${index} 未挂载到 DOM，重新添加到容器`);
            container.innerHTML = '';
            container.appendChild(img);
        }

        img.onload = function() {
            try {
                F.clearLoadingState(container);
                container.classList.add('loaded');
                F.state.loadedCount++;
                F.updatePageInfo();
                img.removeAttribute('data-loading');
                
                // 通知框架图片加载成功（用于懒加载机制）
                if (F.markImageLoaded) {
                    F.markImageLoaded(index);
                }
            } catch (e) {
                console.error(`处理图片失败 (图片 ${index}):`, e);
                img.removeAttribute('data-loading');
                if (retryCount < maxRetries) {
                    setTimeout(() => loadPage(index, retryCount + 1), 1000 * (retryCount + 1));
                } else {
                    F.showError(container, () => loadPage(index, 0));
                    // 通知框架图片加载失败
                    if (F.markImageFailed) {
                        F.markImageFailed(index);
                    }
                }
            }
        };
        
        img.onerror = function(e) {
            console.warn(`加载图片失败 (图片 ${index}), 重试次数：${retryCount}, 错误事件:`, e);
            img.removeAttribute('data-loading');
            if (retryCount < maxRetries) {
                setTimeout(() => loadPage(index, retryCount + 1), 1000 * (retryCount + 1));
            } else {
                F.showError(container, () => loadPage(index, 0));
                // 通知框架图片加载失败
                if (F.markImageFailed) {
                    F.markImageFailed(index);
                }
            }
        };

        img.src = imgUrl;
    }

    // 并发加载多张图片
    function loadImagesConcurrently(startIndex, count) {
        const endIndex = Math.min(startIndex + count, F.state.totalPages);
        const queue = [];
        for (let i = startIndex; i <= endIndex; i++) queue.push(i);
        
        const allPromises = queue.map(index => new Promise(resolve => {
            loadPage(index);
            const checkLoaded = setInterval(() => {
                const container = document.getElementById(`page-${index}`);
                if (container && (container.classList.contains('loaded') || container.querySelector('.error'))) {
                    clearInterval(checkLoaded);
                    resolve();
                }
            }, 50);
        }));
        
        Promise.all(allPromises).then(() => {
            console.log(`批量加载完成：${startIndex} - ${endIndex}`);
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
        const img = container.querySelector('img');
        if (!img || !img.src) {
            F.showToast('图片尚未加载');
            return;
        }
        const link = document.createElement('a');
        link.href = img.src;
        const imageData = F.state.imageUrls[currentIndex - 1];
        link.download = `pixiv_${F.state.id}${imageData.number ? '-' + imageData.number : ''}.jpg`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        F.showToast('下载已触发');
    }

    // 下载所有图片
    async function downloadAll() {
        F.showToast('正在准备下载，请稍候...');

        try {
            const zip = new JSZip();
            const folder = zip.folder(`pixiv_${F.state.id}`);

            let downloadedCount = 0;

            for (let i = 1; i <= F.state.totalPages; i++) {
                const container = document.getElementById(`page-${i}`);
                if (!container) continue;

                const img = container.querySelector('img');
                if (!img || !img.src) {
                    loadPage(i);
                    await new Promise(resolve => setTimeout(resolve, 500));
                }

                if (img && img.src) {
                    try {
                        const response = await fetch(img.src);
                        const blob = await response.blob();
                        const imageData = F.state.imageUrls[i - 1];
                        const fileName = `pixiv_${F.state.id}${imageData.number ? '-' + imageData.number : ''}.jpg`;
                        folder.file(fileName, blob);
                        downloadedCount++;

                        if (downloadedCount % 10 === 0) {
                            F.showToast(`正在准备下载，已处理 ${downloadedCount} 张`);
                        }
                    } catch (e) {
                        console.error(`下载图片 ${i} 失败:`, e);
                    }
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

            F.showToast(`ZIP 已生成 (${downloadedCount} 张图片)，请在侧边栏点击"手动下载 ZIP"按钮下载`);
        } catch (error) {
            console.error('下载失败:', error);
            F.showToast('下载失败，请重试');
        }
    }

    // 初始化
    async function init() {
        const urlParams = new URLSearchParams(window.location.search);
        const pid = urlParams.get('pid') || urlParams.get('id') || urlParams.get('ID') || '';

        if (!pid) {
            document.getElementById('contentTitle').textContent = '请输入作品 ID';
            F.showToast('请在 URL 中添加 ?pid=作品 ID 参数');
            return;
        }

        F.state.id = pid;
        document.getElementById('contentTitle').textContent = `作品 ID: ${F.state.id}`;
        F.showToast('正在发现图片...');

        // 发现所有可用的图片
        F.state.imageUrls = await discoverImages(pid);
        F.state.totalPages = F.state.imageUrls.length;

        if (F.state.totalPages === 0) {
            document.getElementById('contentContainer').innerHTML = '<div style="text-align:center;padding:50px;color:#666;">未找到任何图片</div>';
            document.getElementById('pageInfo').textContent = '0 / 0';
            F.showToast('未找到图片');
            return;
        }

        document.getElementById('pageInfo').textContent = `1 / ${F.state.totalPages}`;

        // 创建图片元素
        const container = document.getElementById('contentContainer');
        for (let i = 1; i <= F.state.totalPages; i++) {
            container.appendChild(createPageElement(i));
        }

        // 初始阶段：只加载前 3 张图片，由框架的懒加载机制处理
        // 不需要在这里主动加载，handleScrollLazyLoad 会在初始化后自动触发
    }

    // 注册到 Framework
    F.registerSource('pixiv', {
        init,
        createPageElement,
        loadPage,
        downloadCurrent,
        downloadAll
    });
})();
