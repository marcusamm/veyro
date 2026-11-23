// Included in the authenticated workshop workspace with its existing request and form helpers.
export const carAdminJs = String.raw`
    const carStatuses = { draft: 'Kladde', published: 'Til salg', sold: 'Solgt' };
    const carPrice = value => new Intl.NumberFormat('da-DK').format(value) + ' kr.';

    function renderCars(el) {
        el.innerHTML = head('Biler til salg') + '<div id="adm-cars"><p>Henter bilerne…</p></div>';
        const container = $('#adm-cars', el);
        function mutate(action) {
            if (container.getAttribute('aria-busy') !== 'true') return busy(container, action);
        }
        async function load(selectedId) {
            const result = await api('cars');
            if (!container.isConnected) return;
            if (selectedId) {
                const car = result.cars.find(item => item.id === selectedId);
                if (!car) throw new Error('Annoncen findes ikke længere.');
                edit(car);
            } else {
                showList(result.cars);
            }
        }
        function showList(cars) {
            container.innerHTML = '<div class="adm-actions"><button class="adm-button" id="adm-car-new">Opret bil</button><a href="/biler-til-salg">Se biler på hjemmesiden</a></div>' +
                (cars.length ? '<ul class="adm-cars-list">' + cars.map(car =>
                    '<li><div><strong>' + esc(car.title) + '</strong><p class="adm-hint">' + carPrice(car.priceDkk) + ' · ' + esc(carStatuses[car.status]) +
                    '</p></div><button type="button" class="adm-button adm-secondary adm-small" data-car-edit="' + esc(car.id) +
                    '" aria-label="Rediger ' + esc(car.title) + '">Rediger</button></li>').join('') + '</ul>' : empty('Du har endnu ingen bilannoncer.'));
            $('#adm-car-new', container).onclick = () => { message(''); edit(null); };
            container.querySelectorAll('[data-car-edit]').forEach(button => {
                button.onclick = () => { message(''); edit(cars.find(car => car.id === Number(button.dataset.carEdit))); };
            });
        }
        function edit(car) {
            const value = field => esc(car?.[field] ?? '');
            const requestId = crypto.randomUUID();
            const status = car ? '<label>Status<select name="status">' + Object.entries(carStatuses).map(([key,label]) =>
                '<option value="' + key + '"' + (car.status === key ? ' selected' : '') + '>' + label + '</option>').join('') + '</select></label>' : '';
            container.innerHTML = '<div class="adm-actions"><button id="adm-cars-back" class="adm-button adm-secondary adm-small" type="button">Til oversigten</button></div>' +
                '<form id="adm-car-form" class="adm-form adm-card adm-gap20"><h3>' + (car ? 'Rediger annonce' : 'Opret bil') + '</h3><div class="adm-form-grid">' +
                '<label class="adm-full">Mærke og model<input required name="title" maxlength="120" placeholder="Fx VW Golf 1.4 TSI" value="' + value('title') + '"></label>' +
                '<label>Pris i kr.<input required type="number" min="1" max="999999999" step="1" name="priceDkk" value="' + value('priceDkk') + '"></label>' +
                '<label>Årgang<input type="number" min="1886" max="' + (new Date().getFullYear()+1) + '" name="modelYear" value="' + value('modelYear') + '"></label>' +
                '<label>Kilometertal<input type="number" min="0" max="9999999" name="mileageKm" value="' + value('mileageKm') + '"></label>' +
                '<label>Drivmiddel<input name="fuel" maxlength="60" placeholder="Fx benzin eller el" value="' + value('fuel') + '"></label>' +
                '<label>Gearkasse<input name="transmission" maxlength="60" placeholder="Fx automatgear" value="' + value('transmission') + '"></label>' + status +
                '<label class="adm-full">Beskrivelse<textarea name="description" maxlength="4000" rows="5">' + value('description') + '</textarea></label></div>' +
                (car ? '<p class="adm-hint">Vælg ”Til salg” for at vise annoncen på hjemmesiden. En solgt bil fjernes fra den offentlige oversigt.</p>' :
                  '<p class="adm-hint">Gem først en kladde. Derefter kan du tilføje billeder og sætte bilen til salg.</p>') +
                '<div class="adm-actions"><button class="adm-button" type="submit">' + (car ? 'Gem ændringer' : 'Gem kladde') + '</button></div></form>' +
                (car ? '<section class="adm-card" id="adm-car-photo-panel"><h3>Billeder</h3><p class="adm-hint">Det første billede vises i oversigten. Du kan tilføje op til otte billeder.</p><div id="adm-car-thumbs"></div>' +
                '<form id="adm-car-images" class="adm-form"><label>Vælg billeder<input type="file" name="photos" accept="image/jpeg,image/png,image/webp" multiple required></label>' +
                '<div class="adm-actions"><button type="submit" class="adm-button adm-secondary">Tilføj billeder</button></div></form></section>' : '');
            $('#adm-cars-back', container).onclick = () => mutate(() => load());
            const form = $('#adm-car-form', container);
            form.onsubmit = event => {
                event.preventDefault();
                mutate(async () => {
                    const fields = Object.fromEntries(new FormData(form));
                    fields.priceDkk = Number(fields.priceDkk);
                    fields.modelYear = fields.modelYear ? Number(fields.modelYear) : null;
                    fields.mileageKm = fields.mileageKm ? Number(fields.mileageKm) : null;
                    const result = await api('cars', 'POST', car ? { ...fields, id: car.id, version: car.version } : { ...fields, status:'draft', requestId });
                    await load(result.id);
                    if (container.isConnected) message(car ? 'Annoncen er opdateret.' : 'Kladden er gemt. Du kan nu tilføje billeder.');
                });
            };
            if (car) wirePhotos(car);
            form.elements.title.focus();
        }
        function wirePhotos(car) {
            const photoPanel = $('#adm-car-photo-panel', container);
            const thumbs = $('#adm-car-thumbs', photoPanel);
            const form = $('#adm-car-images', photoPanel);
            const photoBase = 'cars/' + car.id + '/photos';
            function showPhotos() {
                thumbs.innerHTML = '<ul class="adm-car-photos">' + car.photos.map((photo, i) =>
                    '<li><img alt="Billede ' + (i+1) + ' af ' + esc(car.title) + '" src="/api/admin/' + photoBase + '/' + photo + '" loading="lazy">' +
                    '<button class="adm-button adm-secondary adm-small" type="button" data-remove-photo="' + photo + '" aria-label="Fjern billede ' + (i+1) + '">Fjern billede</button></li>').join('') + '</ul>';
                thumbs.querySelectorAll('[data-remove-photo]').forEach(button => {
                    button.onclick = () => {
                        if (!confirm('Fjern dette billede fra annoncen?')) return;
                        mutate(async () => {
                            const photo = Number(button.dataset.removePhoto);
                            await api(photoBase + '/' + photo + '/remove', 'POST', {});
                            car.photos = car.photos.filter(id => id !== photo);
                            showPhotos();
                            message('Billedet er fjernet.');
                        });
                    };
                });
                form.hidden = car.photos.length >= 8;
            }
            showPhotos();
            form.onsubmit = event => {
                event.preventDefault();
                mutate(async () => {
                    const files = Array.from(form.elements.photos.files);
                    if (car.photos.length + files.length > 8) throw new Error('Vælg højst ' + (8-car.photos.length) + ' billeder mere.');
                    let saved = 0;
                    try {
                        for (const file of files) {
                            const data = await prepareCarPhoto(file);
                            const result = await api(photoBase, 'POST', {data});
                            if (!car.photos.includes(result.id)) car.photos.push(result.id);
                            saved++;
                        }
                    } catch (error) {
                        if (saved) error.message = saved + ' af ' + files.length + ' billeder er gemt. ' + error.message;
                        throw error;
                    } finally {
                        showPhotos();
                    }
                    form.reset();
                    message('Billederne er gemt.');
                });
            };
        }
        busy(container, () => load());
    }

    async function prepareCarPhoto(file) {
        if (!['image/jpeg','image/png','image/webp'].includes(file.type)) throw new Error('Vælg et JPG-, PNG- eller WebP-billede.');
        let image;
        try { image = await createImageBitmap(file); }
        catch { throw new Error('Billedet kunne ikke åbnes. Prøv med et andet foto.'); }
        try {
            const canvas = document.createElement('canvas');
            for (const size of [1600,1280,960,640]) {
                const scale = Math.min(1, size / Math.max(image.width, image.height));
                canvas.width = Math.max(1, Math.round(image.width * scale));
                canvas.height = Math.max(1, Math.round(image.height * scale));
                const ctx = canvas.getContext('2d');
                if (!ctx) throw new Error('Billedet kunne ikke behandles i denne browser.');
                ctx.fillStyle = '#fff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
                const data = canvas.toDataURL('image/jpeg', .82).split(',')[1];
                if (data && data.length <= 655360) return data;
            }
            throw new Error('Billedet er for stort. Prøv en mindre udgave.');
        } finally { image.close(); }
    }
`;

export const carAdminCss = `
.adm-cars-list, .adm-car-photos { list-style:none; margin:20px 0; padding:0; }
.adm-cars-list li { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:16px 0; border-top:1px solid var(--line); overflow-wrap:anywhere; }
.adm-car-photos { display:grid; grid-template-columns:repeat(auto-fill,minmax(min(100%,130px),1fr)); gap:16px; }
.adm-car-photos li { display:grid; gap:6px; }
.adm-car-photos img { width:100%; aspect-ratio:4/3; object-fit:cover; }
`;
