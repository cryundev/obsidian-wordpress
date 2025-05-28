import MarkdownIt from "markdown-it";
import Token from "markdown-it/lib/token";
import { trim } from "lodash-es";


const tokenType = "ob_img";


export interface MarkdownItImageActionParams
{
    src     : string;
    width?  : string;
    height? : string;
}


interface MarkdownItImagePluginOptions
{
    doWithImage : ( img : MarkdownItImageActionParams ) => void;
}


const pluginOptions : MarkdownItImagePluginOptions = {
    doWithImage : () =>
    {
    }
};

export const MarkdownItImagePluginInstance = {
    plugin : plugin, doWithImage : ( action : ( img : MarkdownItImageActionParams ) => void ) =>
    {
        pluginOptions.doWithImage = action;
    }
};

function plugin( md : MarkdownIt ) : void  
{  
    md.inline.ruler.after( "image", tokenType, ( state, silent ) =>  
    {  
        const regex = /^!\[\[([^|\]\n]+)((\|[^|\]\n]+)*)?\]\]/;  
        const match = state.src.slice( state.pos ).match( regex );  
        
        if ( match )  
        {  
            if ( silent )  
            {  
                return true;  
            }  
            
            const token = state.push( tokenType, "img", 0 );  
            
            const matched  = match[ 0 ];  
            const src      = match[ 1 ];  
            const options = match[ 2 ] ? match[ 2 ].split( '|' ).slice( 1 ) : [];
            
            let width  : string | undefined;  
            let height : string | undefined;  
            let align  : string | undefined;
            
            options.forEach( opt => 
            {
                if ( opt === 'center' || opt === 'left' || opt === 'right' )
                {
                    align = opt;
                }
                else if ( /^\d+x\d+$/.test( opt ) )
                {
                    [ width, height ] = opt.split( 'x' );
                }
                else if ( /^\d+$/.test( opt ) )
                {
                    width = opt;
                }
            } );
            
            token.attrs = [ [ "src", src ] ];
            
            if ( width )  token.attrs.push( [ "width",  width  ] );
            if ( height ) token.attrs.push( [ "height", height ] );
            if ( align )  token.attrs.push( [ "align",  align  ] );
            
            if ( pluginOptions.doWithImage )  
            {  
                pluginOptions.doWithImage
                ( {  
                    src    : token.attrs?.[ 0 ]?.[ 1 ], 
                    width  : token.attrs?.[ 1 ]?.[ 1 ], 
                    height : token.attrs?.[ 2 ]?.[ 1 ]  
                } );  
            }  
            
            state.pos += matched.length;  
            
            return true;  
        }  
        else  
        {  
            return false;  
        }  
    } );  
    
    md.renderer.rules.ob_img = ( tokens : Token[], idx : number ) =>  
    {  
        const token = tokens[ idx ];  
        
        const src    = token.attrs?.[ 0 ]?.[ 1 ];  
        
        const width  = token.attrs?.find( a => a[ 0 ] === 'width'  )?.[ 1 ];  
        const height = token.attrs?.find( a => a[ 0 ] === 'height' )?.[ 1 ];  
        const align  = token.attrs?.find( a => a[ 0 ] === 'align'  )?.[ 1 ];
        
        let style = '';
        
        if ( width  ) style += `width:${ width }px;`;
        if ( height ) style += `height:${ height }px;`;
        
        let alignClass = '';
        
        if ( align === 'center' ) alignClass = ' aligncenter';
        if ( align === 'left'   ) alignClass = ' alignleft';
        if ( align === 'right'  ) alignClass = ' alignright';
        
        if ( align )
        {
            return `<figure class="wp-block-image ${ alignClass }"><img src="${ src }" style="${ style }" alt=""/></figure>`;
        }
        
        if ( width )
        {  
            if ( height )  
            {  
                return `<img src="${ src }" width="${ width }" height="${ height }" alt="">`;  
            }  
            return `<img src="${ src }" width="${ width }" alt="">`;  
        }  
        else  
        {  
            return `<img src="${ src }" alt="">`;  
        }  
    };  
}
